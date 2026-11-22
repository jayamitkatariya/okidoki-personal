// Shared by every page of the flight fixture. The trip lives in sessionStorage until payment.
const F = window.FIXTURE || { drift: false, slow: false };
// Drift renames the airline's controls ("Search flights" → "Find fares", #from → #origin), the way a
// site ships a redesign: the same flow, different markup. A recorded skill's selectors stop matching.
const L = (plain, drifted) => (F.drift ? drifted : plain);
const id = (name) => F.drift ? "v2-" + name : name;
const $ = (sel) => document.querySelector(sel);
const trip = () => JSON.parse(sessionStorage.getItem("trip") || "{}");
const save = (patch) => sessionStorage.setItem("trip", JSON.stringify({ ...trip(), ...patch }));

// A real airline site builds its search form after the shell loads.
function ready(build) {
  if (!F.slow) return build();
  const note = document.createElement("p");
  note.id = "loading";
  note.textContent = "Loading flights…";
  document.body.appendChild(note);
  const wait = 700 + Math.floor(Math.random() * 900);
  setTimeout(() => { note.remove(); build(); }, wait);
}

const money = (n) => "$" + Number(n).toFixed(0);
