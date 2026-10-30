import Foundation

/// The script okidoki puts in every page of its browser, in a content world of its own so the page's
/// scripts can neither see nor change it. It reads the page for the agent (a numbered list of what can
/// be clicked or typed into), acts on elements, remembers several ways to find each element again, and
/// reports what the person does while a skill is being recorded.
///
/// Everything is reached through `window.__okidoki`, from `callAsyncJavaScript` in that world.
public enum BrowserPageScript {
    /// The content world's name. Fixed, so recorded skills replay through the same world.
    public static let worldName = "okidoki"
    /// The message handler recorded steps arrive on.
    public static let recordHandler = "okidokiRecord"

    public static let source = #"""
    (() => {
      if (window.__okidoki) return;

      const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[contenteditable=""],[contenteditable=true],' +
        '[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=option],' +
        '[role=combobox],[role=textbox],[role=searchbox],[onclick],[tabindex]:not([tabindex="-1"])';
      const MAX_ELEMENTS = 250;
      let refs = new Map();

      const clean = (s, n = 80) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
      const quote = (s) => s.replace(/"/g, "'");

      function visible(el) {
        if (!el.isConnected) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        const st = getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
      }

      function role(el) {
        const explicit = el.getAttribute('role');
        if (explicit) return explicit;
        const tag = el.tagName.toLowerCase();
        if (tag === 'a') return 'link';
        if (tag === 'select') return 'select';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'summary') return 'button';
        if (tag === 'input') {
          const t = (el.getAttribute('type') || 'text').toLowerCase();
          if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
          if (t === 'checkbox' || t === 'radio') return t;
          if (t === 'search') return 'searchbox';
          if (t === 'password') return 'password';
          return 'textbox';
        }
        if (el.isContentEditable) return 'textbox';
        return tag;
      }

      function labelFor(el) {
        const aria = el.getAttribute('aria-label');
        if (aria) return clean(aria);
        const by = el.getAttribute('aria-labelledby');
        if (by) {
          const text = by.split(/\s+/).map(id => document.getElementById(id)?.innerText || '').join(' ');
          if (clean(text)) return clean(text);
        }
        if (el.id) {
          const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (label && clean(label.innerText)) return clean(label.innerText);
        }
        const wrapping = el.closest('label');
        if (wrapping && clean(wrapping.innerText)) return clean(wrapping.innerText);
        const tag = el.tagName.toLowerCase();
        if (tag !== 'input' && tag !== 'textarea' && tag !== 'select' && clean(el.innerText)) return clean(el.innerText);
        return clean(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') ||
          (['button', 'submit'].includes(el.getAttribute('type')) ? el.value : '') || el.getAttribute('name') || '');
      }

      function describe(el, n) {
        const r = role(el);
        let line = `[${n}] ${r} "${quote(labelFor(el))}"`;
        if (r === 'password') line += ' (password field)';
        else if ('value' in el && ['textbox', 'searchbox', 'combobox'].includes(r) && el.value) line += ` value="${quote(clean(el.value, 60))}"`;
        if (r === 'select' && el.selectedOptions?.[0]) line += ` selected="${quote(clean(el.selectedOptions[0].text, 40))}"`;
        if ((r === 'checkbox' || r === 'radio' || r === 'switch') && (el.checked || el.getAttribute('aria-checked') === 'true')) line += ' checked';
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') line += ' disabled';
        if (r === 'link') {
          try { const u = new URL(el.href); line += ` → ${u.host === location.host ? '' : u.host}${u.pathname.slice(0, 50)}`; } catch {}
        }
        return line;
      }

      // Several ways to find an element again, most specific first. `find` tries them in order.
      function selectorsFor(el) {
        const out = [];
        const tag = el.tagName.toLowerCase();
        for (const attr of ['data-testid', 'data-test', 'data-qa', 'data-cy']) {
          const v = el.getAttribute(attr);
          if (v) out.push(`[${attr}="${CSS.escape(v)}"]`);
        }
        if (el.id && !/\d{3,}|^[a-f0-9-]{16,}$|:/.test(el.id)) out.push(`#${CSS.escape(el.id)}`);
        const name = el.getAttribute('name');
        if (name && ['input', 'select', 'textarea', 'button'].includes(tag)) out.push(`${tag}[name="${CSS.escape(name)}"]`);
        const label = labelFor(el);
        if (label) out.push(`role=${role(el)}|${label}`);
        const text = clean(el.innerText, 60);
        if (text && tag !== 'input') out.push(`text=${tag}|${text}`);
        const ph = el.getAttribute('placeholder');
        if (ph) out.push(`${tag}[placeholder="${CSS.escape(ph)}"]`);
        const aria = el.getAttribute('aria-label');
        if (aria) out.push(`${tag}[aria-label="${CSS.escape(aria)}"]`);
        out.push(cssPath(el));
        return [...new Set(out)];
      }

      function cssPath(el) {
        const parts = [];
        let node = el;
        while (node && node.nodeType === 1 && parts.length < 6) {
          let part = node.tagName.toLowerCase();
          if (node.id && !/\d{3,}|:/.test(node.id)) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
          const siblings = node.parentElement ? [...node.parentElement.children].filter(c => c.tagName === node.tagName) : [];
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
          parts.unshift(part);
          node = node.parentElement;
        }
        return parts.join(' > ');
      }

      function candidates(selector) {
        try {
          // "role=button|Pay now": the part before the first bar, then the rest, bars and all.
          const pair = (s) => { const i = s.indexOf('|'); return [s.slice(0, i), s.slice(i + 1)]; };
          if (selector.startsWith('role=')) {
            const [r, label] = pair(selector.slice(5));
            return [...document.querySelectorAll(INTERACTIVE)].filter(el => role(el) === r && labelFor(el) === label);
          }
          if (selector.startsWith('text=')) {
            const [tag, text] = pair(selector.slice(5));
            return [...document.querySelectorAll(tag)].filter(el => clean(el.innerText, 60) === text);
          }
          return [...document.querySelectorAll(selector)];
        } catch { return []; }
      }

      /** The element a recorded step meant, and which of its selectors found it. */
      function find(selectors) {
        for (let i = 0; i < selectors.length; i++) {
          const found = candidates(selectors[i]).filter(visible);
          if (found.length >= 1) return { el: found[0], matched: i, ambiguous: found.length > 1 };
        }
        return null;
      }

      function pageText() {
        const text = (document.body?.innerText || '').split('\n').map(l => l.trim()).filter(Boolean).join('\n');
        return text.slice(0, 12000);
      }

      function snapshot() {
        refs = new Map();
        const lines = [];
        const seen = new Set();
        const below = innerHeight * 2.5;
        for (const el of document.querySelectorAll(INTERACTIVE)) {
          if (lines.length >= MAX_ELEMENTS) break;
          if (seen.has(el) || !visible(el)) continue;
          // A link wrapping a button, a label wrapping its input: the inner one is what acts.
          if (el.closest('a[href],button') && el.closest('a[href],button') !== el && !['input', 'select', 'textarea'].includes(el.tagName.toLowerCase())) continue;
          const r = el.getBoundingClientRect();
          if (r.bottom < -innerHeight || r.top > below) continue;
          seen.add(el);
          const n = refs.size + 1;
          refs.set(n, el);
          lines.push(describe(el, n));
        }
        return { url: location.href, title: document.title, elements: lines.join('\n'), text: pageText(), count: refs.size };
      }

      const nativeValue = (el, value) => {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        setter ? setter.call(el, value) : (el.value = value);
      };

      function key(el, name) {
        const init = { key: name, code: name === 'Enter' ? 'Enter' : name, keyCode: name === 'Enter' ? 13 : 0, which: name === 'Enter' ? 13 : 0, bubbles: true, cancelable: true };
        // A page whose own Enter handler submits the form: notice, so it isn't submitted twice.
        let submitted = false;
        const form = el.form;
        const saw = () => { submitted = true; };
        form?.addEventListener('submit', saw, true);
        const go = el.dispatchEvent(new KeyboardEvent('keydown', init));
        el.dispatchEvent(new KeyboardEvent('keypress', init));
        el.dispatchEvent(new KeyboardEvent('keyup', init));
        form?.removeEventListener('submit', saw, true);
        // Synthetic keys don't submit forms by themselves.
        if (go && !submitted && name === 'Enter' && form) {
          try { form.requestSubmit(); } catch { form.submit(); }
        }
      }

      function click(el) {
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        const at = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, view: window };
        el.dispatchEvent(new PointerEvent('pointerdown', at));
        el.dispatchEvent(new MouseEvent('mousedown', at));
        el.focus?.();
        el.dispatchEvent(new PointerEvent('pointerup', at));
        el.dispatchEvent(new MouseEvent('mouseup', at));
        el.click();
      }

      function type(el, text, submit) {
        el.scrollIntoView({ block: 'center' });
        el.focus();
        if (el.isContentEditable) {
          document.execCommand('selectAll');
          document.execCommand('insertText', false, text);
        } else {
          nativeValue(el, text);
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (submit) key(el, 'Enter');
      }

      function select(el, value) {
        if (el.tagName !== 'SELECT') { click(el); return 'opened it; pick the option next turn'; }
        const want = value.trim().toLowerCase();
        const option = [...el.options].find(o => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want)
          || [...el.options].find(o => o.text.trim().toLowerCase().includes(want));
        if (!option) throw new Error(`no option "${value}"`);
        nativeValue(el, option.value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return '';
      }

      /**
       * One action. The element is `ref` (from the last snapshot) or `selectors` (from a recording).
       * Returns what was done and the element's selectors, so a run can become a skill.
       */
      function act(a) {
        let el = null, matched = -1;
        if (a.ref != null) {
          el = refs.get(a.ref);
          if (!el || !el.isConnected) return { ok: false, detail: `element ${a.ref} is gone; the page changed` };
        } else if (a.selectors?.length) {
          const hit = find(a.selectors);
          if (!hit) return { ok: false, detail: 'not on this page' };
          el = hit.el; matched = hit.matched;
        }
        try {
          switch (a.action) {
            case 'click': click(el); break;
            case 'type': type(el, a.text ?? '', a.submit); break;
            case 'select': { const note = select(el, a.value ?? ''); if (note) return { ok: true, detail: note, selectors: selectorsFor(el), matched }; break; }
            case 'press': key(el || document.activeElement || document.body, a.key || 'Enter'); break;
            case 'scroll': scrollBy({ top: (a.direction === 'up' ? -0.8 : 0.8) * innerHeight }); break;
            case 'locate': break;
            default: return { ok: false, detail: `unknown action ${a.action}` };
          }
        } catch (e) {
          return { ok: false, detail: String(e?.message || e) };
        }
        return { ok: true, selectors: el ? selectorsFor(el) : [], matched, label: el ? labelFor(el) : '', role: el ? role(el) : '' };
      }

      /** Puts a vault login into the page's username and password fields. */
      function fillLogin(username, password) {
        const fields = [...document.querySelectorAll('input')].filter(visible);
        const pass = fields.find(f => f.type === 'password');
        const user = fields.find(f => /email|user|login|account|phone/i.test(`${f.type} ${f.name} ${f.id} ${f.autocomplete} ${f.placeholder}`) && f.type !== 'password')
          || (pass ? fields[fields.indexOf(pass) - 1] : null);
        if (!user && !pass) return { ok: false, detail: 'no login fields on this page' };
        if (user && username) type(user, username, false);
        if (pass && password) type(pass, password, false);
        return { ok: true, detail: pass ? 'filled' : 'filled the username; the password comes on the next page' };
      }

      /** Resolves once the page has stopped changing for `quietMs`, or after `maxMs` either way. */
      function settle(quietMs = 350, maxMs = 6000) {
        return new Promise(resolve => {
          const started = Date.now();
          let last = Date.now();
          const observer = new MutationObserver(() => { last = Date.now(); });
          observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
          const tick = () => {
            const now = Date.now();
            if ((document.readyState === 'complete' && now - last >= quietMs) || now - started >= maxMs) {
              observer.disconnect();
              resolve(now - started);
            } else setTimeout(tick, 60);
          };
          tick();
        });
      }

      // Recording: what the person does, as steps a replay can find again.
      let recording = false;
      const typed = new WeakMap();
      const post = (step) => { try { window.webkit.messageHandlers.okidokiRecord.postMessage(step); } catch {} };
      const target = (e) => e.target?.closest?.(INTERACTIVE) || e.target;
      const step = (el, action, extra = {}) => ({
        action, url: location.href, title: document.title, selectors: selectorsFor(el),
        label: labelFor(el), role: role(el), tag: el.tagName.toLowerCase(), ...extra,
      });
      let enterAt = 0;
      function flushTyping(el) {
        if (!el) return;
        // Rich editors (a mail body, a chat box) hold their text in the element, not a value.
        const rich = !('value' in el) && el.isContentEditable;
        if (!('value' in el) && !rich) return;
        if (rich) el = el.closest('[contenteditable=""],[contenteditable=true]') || el;
        const value = rich ? (el.innerText ?? '') : (el.value ?? '');
        if (typed.get(el) === value) return;
        typed.set(el, value);
        const secret = el.type === 'password' || /one-time-code|cc-|card/i.test(el.autocomplete || '');
        post(step(el, 'type', secret ? { secret: true, kind: el.type === 'password' ? 'password' : 'secret' } : { text: value }));
      }
      addEventListener('click', e => {
        if (!recording || !e.isTrusted) return;
        const el = target(e);
        if (!el || el === document.body) return;
        const r = role(el);
        if (['textbox', 'searchbox', 'password', 'combobox'].includes(r) && el.tagName !== 'BUTTON') return;
        // Enter in a field makes the browser "click" the form's submit button; the Enter is already recorded.
        if (Date.now() - enterAt < 400 && (el.type === 'submit' || el.tagName === 'BUTTON') && el.form) return;
        post(step(el, 'click'));
      }, true);
      addEventListener('change', e => {
        if (!recording || !e.isTrusted) return;
        const el = e.target;
        if (el.tagName === 'SELECT') post(step(el, 'select', { value: el.selectedOptions?.[0]?.text?.trim() ?? el.value }));
        else if (el.type === 'checkbox' || el.type === 'radio') return;
        else flushTyping(el);
      }, true);
      addEventListener('keydown', e => {
        if (!recording || !e.isTrusted) return;
        if (e.key === 'Enter' && e.target && 'value' in e.target && e.target.tagName !== 'TEXTAREA') {
          flushTyping(e.target);
          post(step(e.target, 'press', { key: 'Enter' }));
          enterAt = Date.now();
        }
      }, true);
      addEventListener('blur', e => { if (recording && e.isTrusted) flushTyping(e.target); }, true);
      // A click elsewhere ends typing in a rich editor, which has no change event.
      addEventListener('pointerdown', e => {
        if (!recording || !e.isTrusted) return;
        const active = document.activeElement;
        if (active && active.isContentEditable && !active.contains(e.target)) flushTyping(active);
      }, true);

      window.__okidoki = {
        snapshot, act, find: (s) => { const hit = find(s); return hit ? { matched: hit.matched, label: labelFor(hit.el), ambiguous: hit.ambiguous } : null; },
        fillLogin, settle, pageText,
        record: (on) => { recording = !!on; return recording; },
      };
    })();
    """#
}
