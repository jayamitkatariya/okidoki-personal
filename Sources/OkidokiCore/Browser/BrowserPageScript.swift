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

      // When the page's structure or text last changed. Watched from the very start, so `settle` can
      // return at once on a page that's already still instead of always waiting out a quiet window.
      // Attribute changes are left out: animations flip classes and styles all the time.
      let lastChange = performance.now();
      new MutationObserver(() => { lastChange = performance.now(); })
        .observe(document, { subtree: true, childList: true, characterData: true });
      // When the page finished loading. Some pages never go still (ads, live tickers, feeds filling in):
      // past this point a short grace is enough, rather than waiting for a quiet that never comes.
      let completeAt = document.readyState === 'complete' ? performance.now() : 0;
      document.addEventListener('readystatechange', () => { if (document.readyState === 'complete') completeAt = performance.now(); });
      const LOADED_GRACE = 500;

      const clean = (s, n = 80) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
      const quote = (s) => s.replace(/"/g, "'");

      /** Every match in the document, in open shadow roots and in same-origin frames. */
      function deepAll(selector, root = document, out = []) {
        out.push(...root.querySelectorAll(selector));
        for (const host of root.querySelectorAll('*')) {
          if (host.shadowRoot) deepAll(selector, host.shadowRoot, out);
          if (host.tagName === 'IFRAME' || host.tagName === 'FRAME') {
            let inner = null;
            try { inner = host.contentDocument; } catch {}
            if (inner && inner.documentElement) deepAll(selector, inner, out);
          }
        }
        return out;
      }

      const viewOf = (el) => el.ownerDocument?.defaultView || window;

      function visible(el) {
        if (!el.isConnected) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        // Parked off the side of the page: skip links and keyboard-shortcut menus that only appear on
        // focus (Amazon's hidden "Add to cart, shift, option, K" adds whatever the page last held).
        const win = viewOf(el);
        if (r.right <= -win.scrollX || r.left >= Math.max(win.innerWidth, win.document.documentElement.scrollWidth)) return false;
        if (el.checkVisibility) return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
        const st = viewOf(el).getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
      }

      function role(el) {
        const tag = el.tagName.toLowerCase();
        // A real dropdown stays one whatever the page calls it (Amazon marks its size picker "combobox"):
        // it's chosen with select, and its options are what matter.
        if (tag === 'select') return 'select';
        const explicit = el.getAttribute('role');
        if (explicit) return explicit;
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
          const root = el.getRootNode?.() || document;
          const text = by.split(/\s+/).map(id => (root.getElementById?.(id) || document.getElementById(id))?.innerText || '').join(' ');
          if (clean(text)) return clean(text);
        }
        if (el.id) {
          const label = (el.getRootNode?.() || document).querySelector?.(`label[for="${CSS.escape(el.id)}"]`);
          if (label && clean(label.innerText)) return clean(label.innerText);
        }
        const wrapping = el.closest('label');
        if (wrapping && clean(wrapping.innerText)) return clean(wrapping.innerText);
        const tag = el.tagName.toLowerCase();
        if (tag !== 'input' && tag !== 'textarea' && tag !== 'select' && clean(el.innerText)) return clean(el.innerText);
        // A form whose labels sit beside their fields rather than pointing at them ("Date of Birth" in the
        // row next to a date box, a custom dropdown's input): the label just before it in its row.
        if (['input', 'textarea', 'select'].includes(tag) && !['checkbox', 'radio', 'button', 'submit'].includes(el.type)) {
          const near = nearbyLabel(el);
          if (near) return near;
        }
        return clean(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') ||
          (['button', 'submit'].includes(el.getAttribute('type')) ? el.value : '') || el.getAttribute('name') ||
          // A product photo that links to the product: its picture's description is its name.
          el.querySelector?.('img[alt]')?.getAttribute('alt') || el.querySelector?.('svg title')?.textContent || '');
      }

      function nearbyLabel(el) {
        let box = el.parentElement;
        for (let depth = 0; box && depth < 5; depth++, box = box.parentElement) {
          const fields = box.querySelectorAll('input:not([type=hidden]),select,textarea');
          if (fields.length > 3) break;
          const labels = [...box.querySelectorAll('label,[id$="-label"]')]
            .filter(l => !l.contains(el) && !l.htmlFor && (l.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
          const text = labels.length ? clean(labels[labels.length - 1].innerText) : '';
          if (text && text.length <= 60) return text;
        }
        return '';
      }

      /** A dropdown's choices, so the agent can pick one it can see; ones the page marks unavailable say so. */
      function optionsOf(el) {
        const out = [];
        let length = 0;
        for (const o of el.options) {
          const text = clean(o.text, 40);
          if (!text) continue;
          const off = o.disabled || /unavailable|disabled|out.?of.?stock|sold.?out/i.test(`${o.className} ${o.getAttribute('aria-disabled') === 'true' ? 'disabled' : ''}`);
          const item = `"${quote(text)}"${off ? ' (unavailable)' : ''}`;
          if (length + item.length > 1500 || out.length >= 60) { out.push(`… ${el.options.length - out.length} more`); break; }
          out.push(item);
          length += item.length + 2;
        }
        return out.length ? ` options: ${out.join(', ')}` : '';
      }

      /** For a bare label like "8" or "M": the heading of the group it's in ("Men's shoe size"). */
      function groupFor(el) {
        let node = el;
        for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
          for (let sib = node.previousElementSibling, k = 0; sib && k < 2; sib = sib.previousElementSibling, k++) {
            const text = clean(sib.innerText, 50);
            if (text && text.length <= 40 && !sib.querySelector(INTERACTIVE) && !sib.matches(INTERACTIVE)) return text;
          }
        }
        return '';
      }

      function describe(el, n) {
        const r = role(el);
        const label = labelFor(el);
        let line = `[${n}] ${r} "${quote(label)}"`;
        if (label.length <= 3 && ['button', 'link', 'radio', 'checkbox', 'option'].includes(r)) {
          const group = groupFor(el);
          if (group && group !== label) line += ` in "${quote(group)}"`;
        }
        if (r === 'password') line += ' (password field)';
        else if ('value' in el && ['textbox', 'searchbox', 'combobox'].includes(r) && el.value) line += ` value="${quote(clean(el.value, 60))}"`;
        if (r === 'select' && el.selectedOptions?.[0]) line += ` selected="${quote(clean(el.selectedOptions[0].text, 40))}"`;
        if (r === 'select' && el.options) line += optionsOf(el);
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
            return deepAll(INTERACTIVE).filter(el => role(el) === r && labelFor(el) === label);
          }
          if (selector.startsWith('text=')) {
            const [tag, text] = pair(selector.slice(5));
            return deepAll(tag).filter(el => clean(el.innerText, 60) === text);
          }
          return deepAll(selector);
        } catch { return []; }
      }

      /** The element a recorded step meant, and which of its selectors found it. */
      function find(selectors) {
        for (let i = 0; i < selectors.length; i++) {
          const found = candidates(selectors[i]).filter(visible);
          if (found.length >= 1) {
            // A label-matched list is often several nested elements that all read the same thing ("Round
            // trip" is a div inside a div inside the combobox). Acting on the innermost one does nothing:
            // prefer the one that is actually a control.
            const interactive = found.find((el) => {
              const r = el.getAttribute('role');
              return r === 'combobox' || r === 'button' || r === 'option' || r === 'tab' || r === 'checkbox'
                || r === 'radio' || r === 'switch' || r === 'link' || r === 'menuitem'
                || el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'SELECT'
                || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.hasAttribute('onclick')
                || el.getAttribute('tabindex') != null;
            });
            return { el: interactive || found[0], matched: i, ambiguous: found.length > 1 };
          }
        }
        return null;
      }

      function pageText() {
        const text = (document.body?.innerText || '').split('\n').map(l => l.trim()).filter(Boolean).join('\n');
        return text.slice(0, 12000);
      }

      /// The page's text for a model to read. `pageText` in reading order caps at 12k, and on a modern app
      /// that cap can land inside the header: a flight list sat below it, so "read the cheapest fare" was
      /// handed a nav bar and answered nothing. Content lines (prices, times, codes, nonstop) come first.
      ///
      /// No de-duplication: a results list repeats the same price on every row ("$159" four times is four
      /// flights), and removing the repeats left one price at the top and four rows that appeared to have
      /// none — the model then correctly answered that it couldn't tie a price to a row.
      function readText() {
        const lines = (document.body?.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);
        const signal = /\$|€|£|₹|\d{1,2}:\d{2}|\b[A-Z]{2,3}\b|\d{3,}|\bnonstop\b|\bstops?\b/i;
        const looksContent = (line) => signal.test(line);
        // One pass in document order, so a row's lines stay together and keep the order the page shows.
        // Nothing is dropped until the cap, and then only from the least useful end.
        const out = [];
        let size = 0;
        for (const line of lines) {
          if (!looksContent(line) && out.length >= 300) continue;
          out.push(line);
          size += line.length + 1;
          if (size > 11000) break;
        }
        return out.join('\n').slice(0, 12000);
      }

      /// A cheap readiness probe, for polling: `innerText` above forces a layout flush and costs tens of
      /// milliseconds on a big page, so a loop that calls it ten times a second stalls the very page it is
      /// waiting for. `textContent` skips layout, and the byte count is enough to tell "still filling in".
      function fill() {
        const body = document.body;
        if (!body) return { len: 0, loading: true, priced: false };
        const text = body.textContent || '';
        return {
          len: text.length,
          loading: /(loading|fetching|searching) (results|flights|offers|prices)/i.test(text.slice(0, 2000)),
          priced: text.includes('$') || text.includes('€') || text.includes('£') || text.includes('₹'),
        };
      }

      function snapshot() {
        refs = new Map();
        const lines = [];
        const seen = new Set();
        const below = innerHeight * 2.5;
        let more = 0;
        for (const el of deepAll(INTERACTIVE)) {
          if (seen.has(el)) continue;
          // Cheap geometry first: most of a long page is far off screen, and style checks cost more.
          const r = el.getBoundingClientRect();
          // Further down (or past the cap): counted, so the agent knows scrolling finds more.
          if (r.top > below || lines.length >= MAX_ELEMENTS) { if (r.width > 0 && r.height > 0 && r.top > -innerHeight) more++; continue; }
          if (r.bottom < -innerHeight) continue;
          if (!visible(el)) continue;
          // A link wrapping a button, a label wrapping its input: the inner one is what acts.
          if (el.closest('a[href],button') && el.closest('a[href],button') !== el && !['input', 'select', 'textarea'].includes(el.tagName.toLowerCase())) continue;
          seen.add(el);
          const n = refs.size + 1;
          refs.set(n, el);
          lines.push(describe(el, n));
        }
        // Pictures that do something on hover (captions, menus) aren't controls: offered too, for hovering,
        // when they say what they are and aren't already inside one.
        let pictures = 0;
        for (const el of deepAll('img[alt]:not([alt=""]),[aria-haspopup]:not(a):not(button)')) {
          if (pictures >= 20 || lines.length >= MAX_ELEMENTS || seen.has(el)) continue;
          if (el.closest('a[href],button')) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 32 || r.height < 32 || r.top > below || r.bottom < -innerHeight || !visible(el)) continue;
          seen.add(el);
          pictures++;
          const n = refs.size + 1;
          refs.set(n, el);
          lines.push(`[${n}] ${el.tagName === 'IMG' ? 'image' : role(el)} "${quote(clean(el.getAttribute('alt') || labelFor(el), 60))}" (hover)`);
        }
        return { url: location.href, title: document.title, elements: lines.join('\n'), text: pageText(), count: refs.size, more };
      }

      const nativeValue = (el, value) => {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        setter ? setter.call(el, value) : (el.value = value);
      };

      const KEY_CODES = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Space: 32, ' ': 32,
        ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, PageUp: 33, PageDown: 34, Home: 36, End: 35 };

      function key(el, name) {
        const code = KEY_CODES[name] ?? (name.length === 1 ? name.toUpperCase().charCodeAt(0) : 0);
        const init = { key: name === 'Space' ? ' ' : name, code: name.length === 1 ? `Key${name.toUpperCase()}` : name, keyCode: code, which: code, bubbles: true, cancelable: true, composed: true };
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
        // Synthetic Tab doesn't move focus by itself either: move it to the next field.
        if (go && name === 'Tab') {
          const order = deepAll('a[href],button,input:not([type=hidden]),select,textarea,[tabindex]:not([tabindex="-1"])').filter(visible);
          const next = order[order.indexOf(el) + 1];
          next?.focus?.();
        }
      }

      /** The element under the middle of the window that scrolls: inner panes (a mail list, a chat) included. */
      function scroller() {
        let node = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
        while (node && node !== document.body && node !== document.documentElement) {
          const st = getComputedStyle(node);
          if (/(auto|scroll|overlay)/.test(st.overflowY) && node.scrollHeight > node.clientHeight + 4) return node;
          node = node.parentElement || node.getRootNode?.().host || null;
        }
        return null;
      }

      function scrollPage(direction) {
        const sign = direction === 'up' ? -1 : 1;
        const page = document.scrollingElement || document.documentElement;
        const canPage = page.scrollHeight > innerHeight + 4;
        const pane = scroller();
        // The window when it scrolls; otherwise the pane the page lives in.
        if (pane && (!canPage || pane.clientHeight > innerHeight * 0.5)) pane.scrollBy({ top: sign * 0.8 * pane.clientHeight });
        else scrollBy({ top: sign * 0.8 * innerHeight });
      }

      function hover(el) {
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        const at = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, view: viewOf(el) };
        for (const type of ['pointerover', 'pointerenter', 'pointermove']) el.dispatchEvent(new PointerEvent(type, at));
        for (const type of ['mouseover', 'mouseenter', 'mousemove']) el.dispatchEvent(new MouseEvent(type, at));
        // CSS :hover only follows the real pointer, which stays the person's. The page's own :hover rules are
        // mirrored onto a class instead, put on the element and everything it sits in.
        hoverStyles(el.ownerDocument || document);
        for (const old of deepAll('.okidoki-hover')) old.classList.remove('okidoki-hover');
        for (let node = el; node && node.nodeType === 1; node = node.parentElement || node.getRootNode()?.host) node.classList.add('okidoki-hover');
      }
      const mirrored = new WeakSet();
      function hoverStyles(doc) {
        const copy = (sheet, into) => {
          let rules;
          try { rules = sheet.cssRules; } catch { return; }  // another site's stylesheet: can't be read
          for (const rule of [...(rules || [])]) {
            if (rule.cssRules && !rule.selectorText) { copy(rule, into); continue; }  // @media and friends
            if (rule.selectorText && rule.selectorText.includes(':hover')) {
              into.push(`${rule.selectorText.replace(/:hover/g, '.okidoki-hover')} { ${rule.style.cssText} }`);
            }
          }
        };
        for (const sheet of [...doc.styleSheets]) {
          if (mirrored.has(sheet)) continue;
          mirrored.add(sheet);
          const rules = [];
          copy(sheet, rules);
          if (!rules.length) continue;
          const style = doc.createElement('style');
          style.setAttribute('data-okidoki', 'hover');
          style.textContent = rules.join('\n');
          (doc.head || doc.documentElement).appendChild(style);
          mirrored.add(style.sheet);
        }
      }

      function click(el) {
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        const at = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, view: viewOf(el), button: 0, buttons: 1 };
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
          // The editor's own document: a rich editor inside a frame (TinyMCE, CKEditor) has its own,
          // and execCommand only reaches the document whose selection is live. Selecting through it
          // (not the top document's) is what makes "select all, then insert" replace the text.
          const doc = el.ownerDocument || document;
          doc.execCommand('selectAll');
          doc.execCommand('insertText', false, text);
          // Some editors ignore a synthetic insertText: fall back to the element's own text, then
          // announce it the way a person's typing would.
          if ((el.innerText ?? '') !== text) {
            el.textContent = text;
            el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText', composed: true }));
          }
        } else {
          nativeValue(el, text);
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (submit) key(el, 'Enter');
      }

      /// A custom dropdown is a div or button that opens a list of `role=option`s. The click that opens it
      /// and the pick from the list are two turns: the list renders on the next frame, so this turn can
      /// only open it and report "not on this page" — which the caller retries.
      function pickFromMenu(el, value) {
        const want = value.trim().toLowerCase();
        const options = deepAll('[role=option],[role=menuitem]').filter(visible);
        const pick = options.find((o) => clean(o.innerText, 80).toLowerCase() === want)
          || options.find((o) => clean(o.innerText, 80).toLowerCase().includes(want));
        if (!pick) {
          // Not open yet: open it. The next look finds the list.
          if (!options.length) { click(el); return 'not on this page'; }
          return 'opened it; pick the option next turn';
        }
        click(pick);
        return '';
      }

      function select(el, value) {
        if (el.tagName !== 'SELECT') {
          // A custom dropdown (Google Flights' "Round trip", a shop's size picker) is a button that
          // opens a list. Pass the note straight through: "not on this page" means "look again", and
          // reporting success for it made every replayed choice silently not happen.
          return pickFromMenu(el, value);
        }
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
            case 'hover': hover(el); break;
            case 'type': {
              // Vault secrets only go where they belong: the password into a password field, the
              // username into an ordinary text field. Anything else (a search box, a comment) is refused.
              const isPassword = el && (el.getAttribute('type') || '').toLowerCase() === 'password';
              if (a.secret === 'password' && !isPassword) return { ok: false, detail: 'that field isn\'t a password field, so the password wasn\'t typed' };
              if (a.secret === 'username' && (isPassword || !el || !/^(input)$/i.test(el.tagName))) return { ok: false, detail: 'that field isn\'t a sign-in field, so the username wasn\'t typed' };
              type(el, a.text ?? '', a.submit);
              break;
            }
            // A custom dropdown needs two passes: the first click opens its menu, the second picks from it.
            // The first pass has to report "not yet" rather than success — returning ok with a note made
            // the caller believe the choice had landed, so it never looked again and the field kept its
            // old value. That one detail is why replayed trip-type choices never stuck.
            case 'select': {
              const note = select(el, a.value ?? '');
              if (note === 'not on this page') return { ok: false, detail: note, selectors: selectorsFor(el), matched };
              if (note) return { ok: true, detail: note, selectors: selectorsFor(el), matched };
              break;
            }
            case 'press': key(el || document.activeElement || document.body, a.key || 'Enter'); break;
            case 'scroll': scrollPage(a.direction); break;
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
        const fields = deepAll('input').filter(visible);
        const pass = fields.find(f => f.type === 'password');
        const user = fields.find(f => /email|user|login|account|phone/i.test(`${f.type} ${f.name} ${f.id} ${f.autocomplete} ${f.placeholder}`) && f.type !== 'password')
          || (pass ? fields[fields.indexOf(pass) - 1] : null);
        if (!user && !pass) return { ok: false, detail: 'no login fields on this page' };
        if (user && username) type(user, username, false);
        if (pass && password) type(pass, password, false);
        return { ok: true, detail: pass ? 'filled' : 'filled the username; the password comes on the next page' };
      }

      /**
       * Resolves once the document is parsed and hasn't changed for `quietMs`, or after `maxMs` either way.
       * `fresh` (right after an action) measures quiet from now, so a reply the action set off still gets
       * its moment; otherwise a page that's already been still returns at once. Images, ads and trackers
       * still loading don't hold it up: the page is readable long before they finish.
       */
      function settle(quietMs = 250, maxMs = 6000, fresh = false) {
        return new Promise(resolve => {
          const started = performance.now();
          const tick = () => {
            const now = performance.now();
            const since = fresh ? Math.max(lastChange, started) : lastChange;
            const quiet = document.readyState !== 'loading' && now - since >= quietMs;
            const loaded = completeAt > 0 && now - (fresh ? Math.max(completeAt, started) : completeAt) >= LOADED_GRACE;
            if (quiet || loaded || now - started >= maxMs) {
              resolve(Math.round(now - started));
            } else setTimeout(tick, 40);
          };
          tick();
        });
      }

      // Recording: what the person does, as steps a replay can find again.
      let recording = false;
      // Tests only: scripted clicks count as the person's (okidoki's own world can set it; a page can't reach it).
      let trustScripted = false;
      const typed = new WeakMap();
      const post = (step) => { try { window.webkit.messageHandlers.okidokiRecord.postMessage(step); } catch {} };
      // The element itself, not the shadow host the event was retargeted to.
      const origin = (e) => (e.composedPath?.()[0]) || e.target;
      const target = (e) => { const t = origin(e); return t?.closest?.(INTERACTIVE) || t; };
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
        if (!recording || (!e.isTrusted && !trustScripted)) return;
        const el = target(e);
        if (!el || el === document.body) return;
        const r = role(el);
        if (['textbox', 'searchbox', 'password', 'combobox', 'select'].includes(r) && el.tagName !== 'BUTTON') return;
        // Enter in a field makes the browser "click" the form's submit button; the Enter is already recorded.
        if (Date.now() - enterAt < 400 && (el.type === 'submit' || el.tagName === 'BUTTON') && el.form) return;
        post(step(el, 'click'));
      }, true);
      addEventListener('change', e => {
        if (!recording || (!e.isTrusted && !trustScripted)) return;
        const el = e.target;
        if (el.tagName === 'SELECT') post(step(el, 'select', { value: el.selectedOptions?.[0]?.text?.trim() ?? el.value }));
        else if (el.type === 'checkbox' || el.type === 'radio') return;
        else flushTyping(el);
      }, true);
      addEventListener('keydown', e => {
        if (!recording || (!e.isTrusted && !trustScripted)) return;
        const el = origin(e);
        if (e.key === 'Enter' && el && 'value' in el && el.tagName !== 'TEXTAREA') {
          flushTyping(el);
          post(step(el, 'press', { key: 'Enter' }));
          enterAt = Date.now();
        }
      }, true);
      addEventListener('blur', e => { if (recording && (e.isTrusted || trustScripted)) flushTyping(origin(e)); }, true);
      // A click elsewhere ends typing in a rich editor, which has no change event.
      addEventListener('pointerdown', e => {
        if (!recording || (!e.isTrusted && !trustScripted)) return;
        const active = document.activeElement;
        if (active && active.isContentEditable && !active.contains(e.target)) flushTyping(active);
      }, true);

      // Smart replay's quick looks: no refs, nothing clicked unless asked.
      /** Up to six visible headings (dialog titles first), for knowing which page or step this is. */
      function headings() {
        const out = [];
        for (const el of deepAll('dialog[open] h1, dialog[open] h2, [role=dialog] h2, h1, h2, h3, legend, [role=heading]')) {
          if (!visible(el)) continue;
          const text = clean(el.innerText, 80);
          if (text && !out.includes(text)) out.push(text);
          if (out.length >= 6) break;
        }
        return out;
      }
      /** What the element a step's selectors find holds now: a field's value, a dropdown's chosen text, a box's tick. */
      function valueOf(selectors) {
        const hit = find(selectors || []);
        if (!hit) return null;
        const el = hit.el;
        if (el.tagName === 'SELECT') { const o = el.options[el.selectedIndex]; return { value: el.value, text: o ? clean(o.text, 200) : '' }; }
        if (el.type === 'checkbox' || el.type === 'radio') return { value: el.checked ? 'on' : '', text: el.checked ? 'checked' : '' };
        if (el.isContentEditable) return { value: el.innerText, text: el.innerText };
        // A custom dropdown (Google Flights' "Round trip") is a div or a button whose chosen text is
        // its label, not a value: reading only `value` made every replayed choice look like it failed
        // ("shows “”") and sent the step to the model for help it didn't need. Its whole subtree also
        // holds every option, so the chosen one (aria-selected / aria-checked, else the first) is read
        // — not the container's concatenated text, which made every check compare against a menu.
        if (el.value != null && el.value !== '') return { value: el.value, text: el.value };
        const chosenOption = [...el.querySelectorAll('[role=option],[role=menuitem]')]
          .find(o => o.getAttribute('aria-selected') === 'true' || o.getAttribute('aria-checked') === 'true')
          || el.querySelector('[aria-selected=true]');
        const chosen = chosenOption
          ? clean(chosenOption.innerText || chosenOption.getAttribute('aria-label') || '', 200)
          : clean(el.innerText || el.getAttribute('aria-label') || el.getAttribute('aria-valuetext') || '', 200);
        return { value: chosen, text: chosen };
      }
      function present(selector) { return candidates(selector).some(visible); }
      /** A dropdown's option texts, for matching a value written another way ("24(b)" → "24B"). */
      function optionsAt(selectors) {
        const hit = find(selectors || []);
        if (!hit || hit.el.tagName !== 'SELECT') return null;
        return [...hit.el.options].map(o => clean(o.text, 120)).filter(Boolean);
      }
      /** Clicks the visible button or link whose label or text is exactly `label` (a popup's "Accept all"). */
      function clickText(label) {
        const want = (label || '').trim().toLowerCase();
        const el = deepAll('button, a, [role=button], input[type=button], input[type=submit]')
          .find(e => visible(e) && [labelFor(e), clean(e.innerText || e.value || '', 80)].some(t => (t || '').trim().toLowerCase() === want));
        if (!el) return false;
        el.click();
        return true;
      }

      /**
       * Popups in the way: open dialogs, and anything without a role that covers the middle of the window
       * from above the page (a fixed overlay). Each with its text and its buttons' labels.
       */
      const modals = new WeakSet();
      function dialogBoxes() {
        const boxes = [];
        const add = (el, modal) => { if (el && !boxes.includes(el) && visible(el)) { boxes.push(el); if (modal) modals.add(el); } };
        for (const el of deepAll('dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]')) add(el, true);
        let node = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
        while (node && node !== document.body && node !== document.documentElement) {
          const st = getComputedStyle(node);
          if (st.position === 'fixed' || st.position === 'sticky') {
            const r = node.getBoundingClientRect();
            if (r.width * r.height >= innerWidth * innerHeight * 0.2) add(node, true);
            break;
          }
          node = node.parentElement;
        }
        // Fixed bars and boxes elsewhere (a cookie bar at the bottom) that hold buttons.
        for (const el of document.body ? document.body.children : []) {
          if (boxes.includes(el) || !visible(el)) continue;
          const st = getComputedStyle(el);
          if ((st.position === 'fixed' || st.position === 'sticky') && Number(st.zIndex || 0) >= 0 && el.querySelector('button,[role=button]')) add(el);
        }
        return boxes.slice(0, 4);
      }
      const BUTTONS = 'button,a[href],[role=button],input[type=button],input[type=submit]';
      function dialogs() {
        return dialogBoxes().map(el => ({
          text: clean(el.innerText, 400), modal: modals.has(el),
          buttons: [...el.querySelectorAll(BUTTONS)].filter(visible).map(b => labelFor(b) || clean(b.innerText || b.value || '', 40)).filter(Boolean).slice(0, 8),
        })).filter(d => d.buttons.length);
      }
      /** Clicks the button labelled exactly `label` inside a popup (never one on the page behind it). */
      function clickInDialog(label) {
        const want = (label || '').trim().toLowerCase();
        for (const box of dialogBoxes()) {
          const el = [...box.querySelectorAll(BUTTONS)].find(b => visible(b) &&
            [labelFor(b), clean(b.innerText || b.value || '', 80)].some(t => (t || '').trim().toLowerCase() === want));
          if (el) { click(el); return true; }
        }
        return false;
      }
      /** Whether the element these selectors find sits inside a popup (then the popup is the step's own). */
      function inDialog(selectors) {
        const hit = find(selectors || []);
        if (!hit) return false;
        return dialogBoxes().some(box => box.contains(hit.el));
      }
      /**
       * A check only a person can pass: a captcha, a "verify you're human" wall, a one-time code box.
       * {kind: "captcha" | "code", text} or null. By the widgets' own markers and their usual words.
       */
      function humanCheck() {
        // A widget the person already passed (its token filled in) isn't in the way any more.
        const solved = deepAll('textarea[name="g-recaptcha-response"],textarea[name="h-captcha-response"],input[name="cf-turnstile-response"]')
          .some(el => (el.value || '').length > 20);
        // Challenge frames big enough to be the thing in the way: not reCAPTCHA's corner badge, not an
        // invisible widget waiting on a submit, not a 1px tracking frame.
        const challenge = deepAll('iframe').filter(visible).filter(f => {
          const src = f.src || '';
          if (!/recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile|arkoselabs|funcaptcha|captcha/i.test(src)) return false;
          if (f.closest('.grecaptcha-badge') || /[?&]size=invisible/i.test(src)) return false;
          const r = f.getBoundingClientRect();
          return r.width >= 60 && r.height >= 50;
        });
        // The challenge picture grid (reCAPTCHA's bframe, hCaptcha's challenge) is in the way even if solved before.
        const grid = challenge.some(f => /bframe|hcaptcha.*challenge|frame=challenge/i.test(f.src || '') && f.getBoundingClientRect().height > 200);
        if (grid || (challenge.length && !solved)) return { kind: 'captcha', text: 'a captcha' };
        if (deepAll('#challenge-form,#cf-challenge-running,#challenge-stage').some(visible)) return { kind: 'captcha', text: 'a captcha' };
        // Words count only where they're the point of the page: its title, a heading, a dialog, or a page
        // short enough to be nothing but the check. A footer's "security check" isn't one.
        const body = (document.body?.innerText || '');
        const prominent = [document.title,
          ...deepAll('h1,h2,h3,legend,[role=dialog],[role=alertdialog],dialog[open],[aria-modal=true]').filter(visible).map(el => (el.innerText || '').slice(0, 600))]
          .join('\n');
        const where = body.length < 1500 ? body : prominent;
        const said = where.match(/verify (that )?you('| a)re (a )?human|i'?m not a robot|are you a robot|checking (if the site connection is secure|your browser)|press (and|&) hold|unusual traffic|security check|prove you('| a)re human|confirm you('| a)re (a )?human/i);
        if (said && !solved) return { kind: 'captcha', text: said[0].toLowerCase() };
        // A one-time code: the browser's own hint, or a code-shaped box under a heading asking for one.
        const codeBoxes = deepAll('input[autocomplete=one-time-code]').filter(visible);
        if (codeBoxes.length) return { kind: 'code', text: 'a one-time code' };
        const asks = (body.length < 1500 ? body : prominent).match(/enter the (\d-digit |verification |security )?code|we (just )?sent (you )?a code|verification code|two-factor|2-step verification|authenticator app/i);
        const codeShaped = deepAll('input:not([type=hidden]):not([type=password]):not([type=checkbox]):not([type=radio])').filter(visible)
          .some(el => /code|otp|token|pin|2fa|mfa/i.test([el.name, el.id, el.placeholder, el.getAttribute('aria-label')].join(' '))
            || el.inputMode === 'numeric' || (el.maxLength > 0 && el.maxLength <= 8));
        if (asks && codeShaped) return { kind: 'code', text: asks[0].toLowerCase() };
        return null;
      }

      /** Where the page is, for knowing when a person has finished with it: still loading, and any check on it. */
      function checkState() {
        return { url: location.href, ready: document.readyState === 'complete' && !busy(), check: humanCheck() };
      }

      /** Something on the page says it's still loading. */
      function busy() {
        if (document.readyState === 'loading') return true;
        if (deepAll('[aria-busy=true],[role=progressbar],.spinner,.loading,.loader,#loading').some(visible)) return true;
        const text = (document.body?.innerText || '').trim();
        // A results page says it's fetching before its list exists ("Loading results", "Fetching results"):
        // that's the page still working, even with no spinner in the tree. Only these phrases — a bare
        // "loading" appears on plenty of finished pages and would make every step wait for nothing.
        if (/\b(loading|fetching|searching) (results|flights|offers|prices|hotels|items)\b/i.test(text.slice(0, 1200))) return true;
        return text.length < 400 && /^(loading|please wait|just a moment)/im.test(text.split('\n').slice(-3).join('\n'));
      }

      window.__okidoki = {
        headings, valueOf, present, clickText, optionsOf: optionsAt, dialogs, clickInDialog, inDialog, busy, humanCheck, checkState,
        snapshot, act, fill, readText, find: (s) => { const hit = find(s); return hit ? { matched: hit.matched, label: labelFor(hit.el), ambiguous: hit.ambiguous } : null; },
        fillLogin, settle, pageText,
        record: (on) => { recording = !!on; return recording; },
        trustScripted: (on) => { trustScripted = !!on; return trustScripted; },
      };
    })();
    """#
}
