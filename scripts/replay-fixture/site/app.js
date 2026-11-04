// Shared by every page of the fixture. State lives in sessionStorage until the review page submits it.
const F = window.FIXTURE || { drift: false, banner: false };
// Hard mode (each can be switched on by itself through /config):
//   randomIds — every id gets a fresh suffix on each load, the way generated front ends do
//   slow      — each page builds its form 0.7–2.4s after loading; submitting takes a few seconds
//   popups    — a cookie banner, and a "stay signed in" dialog that shows up while you're typing and
//               swallows clicks and submits until it's dismissed
//   expire    — the session runs out once per return: the deductions page sends you back to sign in
//   busy      — the first submit of each return fails with "service busy, try again"
const RAND = Math.random().toString(36).slice(2, 6);
const state = () => JSON.parse(sessionStorage.getItem("filing") || "{}");
const save = (patch) => sessionStorage.setItem("filing", JSON.stringify({ ...state(), ...patch }));
// Drift renames buttons and ids, so recorded selectors and labels stop matching.
const L = (plain, drifted) => (F.drift ? drifted : plain);
const id = (name) => (F.drift ? "v2-" + name : name) + (F.randomIds ? "-" + RAND : "");
const $ = (sel) => document.querySelector(sel);

function banner() {
  if (!(F.banner || F.drift || F.popups) || sessionStorage.getItem("cookies")) return;
  const box = document.createElement("div");
  box.className = "overlay";
  box.innerHTML = `<div class="dialog"><p>We use cookies to keep you signed in.</p><button id="accept-cookies">Accept all</button></div>`;
  document.body.appendChild(box);
  $("#accept-cookies").onclick = () => { sessionStorage.setItem("cookies", "1"); box.remove(); };
}

function survey() {
  if (!F.drift || sessionStorage.getItem("survey")) return;
  const box = document.createElement("div");
  box.className = "overlay";
  box.innerHTML = `<div class="dialog"><p>Quick survey: how was filing last year?</p><button id="survey-later">Maybe later</button></div>`;
  document.body.appendChild(box);
  $("#survey-later").onclick = () => { sessionStorage.setItem("survey", "1"); box.remove(); };
}

// "1250000" → "12,50,000" as the person types, the way Indian tax sites format money.
function moneyMask(input) {
  input.addEventListener("input", () => {
    const digits = input.value.replace(/\D/g, "");
    if (!digits) { input.value = ""; return; }
    const last3 = digits.slice(-3);
    const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
    input.value = rest ? rest + "," + last3 : last3;
  });
}
const digits = (value) => String(value || "").replace(/\D/g, "");

// The page's own script, run when the page is "ready": at once, or after a delay on a slow site.
function ready(build) {
  if (!F.slow) return build();
  const wait = 700 + Math.floor(Math.random() * 1700);
  const note = document.createElement("p");
  note.id = "loading"; note.textContent = "Loading…";
  document.body.appendChild(note);
  setTimeout(() => { note.remove(); build(); }, wait);
}

// While a dialog is open the page ignores clicks and submits behind it, like a real modal.
const blocked = () => !!document.querySelector(".overlay");

function staySignedIn() {
  if (!F.popups || sessionStorage.getItem("stay-" + location.pathname)) return;
  setTimeout(() => {
    const box = document.createElement("div");
    box.className = "overlay";
    box.innerHTML = `<div class="dialog"><p>Your session will time out in 2 minutes. Do you want to stay signed in?</p>
      <button id="${id("stay")}">Stay signed in</button> <button id="${id("signout")}">Sign out</button></div>`;
    document.body.appendChild(box);
    $("#" + id("stay")).onclick = () => { sessionStorage.setItem("stay-" + location.pathname, "1"); box.remove(); };
    $("#" + id("signout")).onclick = () => { sessionStorage.clear(); location.href = "login.html"; };
  }, 500 + Math.floor(Math.random() * 600));
}

// A product tour on the review page, with buttons no rule knows: the first time, only the model can
// tell which one gets you back to the return.
function whatsNew() {
  if (!F.popups || sessionStorage.getItem("tour")) return;
  const box = document.createElement("div");
  box.className = "overlay";
  box.setAttribute("role", "dialog");
  box.innerHTML = `<div class="dialog"><h2>New this year</h2><p>You can now e-verify your return in one tap after filing.</p>
    <button id="${id("tour-show")}">Show me how</button> <button id="${id("tour-back")}">Back to my return</button></div>`;
  document.body.appendChild(box);
  $("#" + id("tour-back")).onclick = () => { sessionStorage.setItem("tour", "1"); box.remove(); };
  $("#" + id("tour-show")).onclick = () => { location.href = "login.html"; };
}

// Random: each page load may change in ways no recording saw — a page inserted into the flow, a new
// required box, a renamed or decoy button, a promo banner, a toast with "Undo", a chat widget.
const chance = (p) => F.random && Math.random() < p;
function noise() {
  if (!F.random) return;
  if (chance(0.5)) {
    const promo = document.createElement("div");
    promo.className = "promo";
    promo.innerHTML = `File early, get your refund faster! <a href="#" onclick="return false">Learn more</a>`;
    document.body.prepend(promo);
  }
  const chat = document.createElement("div");
  chat.className = "chat";
  chat.innerHTML = `<button type="button" id="${id("chat")}">Chat with us</button>`;
  document.body.appendChild(chat);
  if (chance(0.4)) setTimeout(() => {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.innerHTML = `Draft saved. <button type="button" id="${id("undo")}">Undo</button>`;
    document.body.appendChild(toast);
    $("#" + id("undo")).onclick = () => { sessionStorage.removeItem("filing"); toast.remove(); };
    setTimeout(() => toast.remove(), 4000);
  }, 300 + Math.random() * 900);
}

// Decoys: what real pages carry that is NOT a check in the way — reCAPTCHA's invisible corner badge, a
// long legal footer that mentions security checks and two-factor sign-in. A replay must not stop for these.
function decoys() {
  if (!F.decoys || document.querySelector(".grecaptcha-badge")) return;
  const badge = document.createElement("div");
  badge.className = "grecaptcha-badge";
  badge.style.cssText = "position:fixed;right:0;bottom:14px;width:256px;height:60px;z-index:5";
  badge.innerHTML = `<iframe src="recaptcha-frame.html?k=fixture&size=invisible" width="256" height="60" title="reCAPTCHA" style="border:0"></iframe>`;
  document.body.appendChild(badge);
  const footer = document.createElement("footer");
  footer.className = "legal";
  footer.innerHTML = "<p>" + ("Acme Filing runs an automated security check on every return before it is accepted. "
    + "Turn on two-factor sign-in in your profile to protect your account; we will never ask for a verification code by phone. "
    + "Returns are processed in the order received and acknowledgements are sent to the email on file. ").repeat(6) + "</p>";
  document.body.appendChild(footer);
}
document.addEventListener("DOMContentLoaded", decoys);
