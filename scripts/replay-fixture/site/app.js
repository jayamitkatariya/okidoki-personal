// Shared by every page of the fixture. State lives in sessionStorage until the review page submits it.
const F = window.FIXTURE || { drift: false, banner: false };
const state = () => JSON.parse(sessionStorage.getItem("filing") || "{}");
const save = (patch) => sessionStorage.setItem("filing", JSON.stringify({ ...state(), ...patch }));
// Drift renames buttons and ids, so recorded selectors and labels stop matching.
const L = (plain, drifted) => (F.drift ? drifted : plain);
const id = (name) => (F.drift ? "v2-" + name : name);
const $ = (sel) => document.querySelector(sel);

function banner() {
  if (!(F.banner || F.drift) || sessionStorage.getItem("cookies")) return;
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
