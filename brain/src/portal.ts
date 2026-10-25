// The entry workbench a customs brokerage files through: a CBP Form 7501 entry summary, checked and
// priced here, transmitted to ACE's certification (test) environment. Served at /ace without the
// sidecar token so a browser on this Mac can open it; it only ever listens on 127.0.0.1.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const FILER_CODE = "MT9";

/** FY2027 user fees (CBP Dec. 26-14, 91 FR 48398), required for entries on or after October 1, 2026. */
export const FEES = { mpfRate: 0.003464, mpfMin: 34.58, mpfMax: 670.86, hmfRate: 0.00125 };

export const IMPORTERS: Record<string, { name: string; address: string }> = {
  "16-4827193-00": { name: "Lakeshore Electronics Inc.", address: "2250 Walden Ave, Cheektowaga, NY 14225" },
  "22-3190457-00": { name: "Harborview Home Goods LLC", address: "40 Commerce Dr, Edison, NJ 08837" },
  "38-6612049-00": { name: "Great Lakes Cycle Co.", address: "1180 Military Rd, Buffalo, NY 14217" },
};

export const PORTS: Record<string, string> = {
  "0901": "Buffalo-Niagara Falls, NY",
  "0712": "Champlain-Rouses Point, NY",
  "3801": "Detroit, MI",
  "4601": "New York/Newark Area, NJ",
  "1001": "New York, NY",
  "4701": "John F. Kennedy Airport, NY",
  "2704": "Los Angeles, CA",
  "2709": "Long Beach, CA",
  "1703": "Savannah, GA",
  "5301": "Houston, TX",
  "3901": "Chicago, IL",
};

export const MODES: Record<string, string> = {
  "10": "Vessel, non-container",
  "11": "Vessel, container",
  "20": "Rail, non-container",
  "21": "Rail, container",
  "30": "Truck, non-container",
  "31": "Truck, container",
  "40": "Air, non-container",
  "41": "Air, container",
};

export const CARRIERS: Record<string, string> = {
  MAEU: "Maersk A/S",
  ONEY: "Ocean Network Express",
  CMDU: "CMA CGM",
  HLCU: "Hapag-Lloyd",
  MSCU: "Mediterranean Shipping Co.",
  EGLV: "Evergreen Marine",
  NFLT: "Niagara Freight Lines",
};

export const COUNTRIES: Record<string, string> = {
  TW: "Taiwan", MY: "Malaysia", CA: "Canada", MX: "Mexico", VN: "Vietnam", KR: "Korea, Republic of",
  JP: "Japan", DE: "Germany", IN: "India", CN: "China", TH: "Thailand",
};

/** General rates and units of quantity from the USITC HTS (hts.usitc.gov). */
export const HTS: Record<string, { description: string; rate: number; rateText: string; unit: string }> = {
  "8471.30.0100": { description: "Portable automatic data processing machines, ≤ 10 kg", rate: 0, rateText: "Free", unit: "No." },
  "8507.60.0090": { description: "Lithium-ion batteries, other", rate: 0.034, rateText: "3.4%", unit: "No." },
  "3924.10.4000": { description: "Tableware and kitchenware of plastics, other", rate: 0.034, rateText: "3.4%", unit: "No." },
  "8517.13.0000": { description: "Smartphones", rate: 0, rateText: "Free", unit: "No." },
  "9403.60.8093": { description: "Wooden furniture, other", rate: 0, rateText: "Free", unit: "No." },
  "6109.10.0012": { description: "T-shirts of cotton, knitted, men's", rate: 0.165, rateText: "16.5%", unit: "doz." },
  "8712.00.2500": { description: "Bicycles, < 16.3 kg, wheels ≥ 63.5 cm", rate: 0.055, rateText: "5.5%", unit: "No." },
};

/** Special program indicators that clear duty for goods of the right origin. */
const SPI: Record<string, string[]> = { S: ["CA", "MX"], "S+": ["CA", "MX"] };

export interface EntryInput {
  ref?: unknown; port?: unknown; mode?: unknown; importDate?: unknown; ior?: unknown; mid?: unknown;
  carrier?: unknown; bl?: unknown; origin?: unknown; hts?: unknown; quantity?: unknown; value?: unknown; spi?: unknown;
}

export interface PortalEntry {
  entryNumber: string;
  ref: string;
  status: "ACCEPTED";
  entryType: "01";
  port: string; portName: string;
  mode: string; modeName: string;
  importDate: string;
  ior: string; importer: string;
  mid: string;
  carrier: string; carrierName: string;
  bl: string;
  origin: string; originName: string;
  line: { hts: string; description: string; quantity: number; unit: string; value: number; rateText: string; spi: string; duty: number };
  totals: { duty: number; mpf: number; hmf: number; fees: number; total: number };
  transmittedAt: number;
}

const round = (n: number) => Math.round(n * 100) / 100;
const text = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const number = (v: unknown) => Number(text(v).replace(/[$,\s]/g, ""));
export const normalizeHts = (v: string) => {
  const digits = v.replace(/\D/g, "");
  return digits.length === 10 ? `${digits.slice(0, 4)}.${digits.slice(4, 6)}.${digits.slice(6)}` : v.trim();
};

export function totals(value: number, rate: number, mode: string, spiClears: boolean) {
  const duty = spiClears ? 0 : round(value * rate);
  const mpf = round(Math.min(FEES.mpfMax, Math.max(FEES.mpfMin, value * FEES.mpfRate)));
  const hmf = mode.startsWith("1") ? round(value * FEES.hmfRate) : 0;
  const fees = round(mpf + hmf);
  return { duty, mpf, hmf, fees, total: round(duty + fees) };
}

/** Field problems in the words a broker's system would use; an empty list means it can go. */
export function validate(input: EntryInput): { errors: { field: string; message: string }[]; entry?: Omit<PortalEntry, "entryNumber" | "transmittedAt" | "status" | "entryType"> } {
  const errors: { field: string; message: string }[] = [];
  const need = (field: string, value: string, message: string) => { if (!value) errors.push({ field, message }); };
  const ref = text(input.ref).toUpperCase();
  const port = text(input.port);
  const mode = text(input.mode);
  const importDate = text(input.importDate);
  const ior = text(input.ior);
  const mid = text(input.mid).toUpperCase();
  const carrier = text(input.carrier).toUpperCase();
  const bl = text(input.bl).toUpperCase();
  const origin = text(input.origin).toUpperCase();
  const hts = normalizeHts(text(input.hts));
  const quantity = number(input.quantity);
  const value = number(input.value);
  const spi = text(input.spi).toUpperCase();

  need("ref", ref, "Broker reference is required");
  if (!PORTS[port]) errors.push({ field: "port", message: port ? `Port ${port} is not a valid port of entry` : "Port of entry is required" });
  if (!MODES[mode]) errors.push({ field: "mode", message: mode ? `Mode ${mode} is not a valid mode of transport` : "Mode of transport is required" });
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(importDate)) errors.push({ field: "importDate", message: "Import date must be MM/DD/YYYY" });
  if (!IMPORTERS[ior]) errors.push({ field: "ior", message: ior ? `Importer ${ior} is not on file (CBP Form 5106 needed)` : "Importer of record number is required" });
  if (!/^[A-Z]{2}[A-Z0-9]{3,13}$/.test(mid)) errors.push({ field: "mid", message: mid ? "Manufacturer ID is not in MID format" : "Manufacturer ID is required" });
  if (!CARRIERS[carrier]) errors.push({ field: "carrier", message: carrier ? `SCAC ${carrier} is not a known carrier` : "Carrier SCAC is required" });
  need("bl", bl, "Bill of lading is required");
  if (!COUNTRIES[origin]) errors.push({ field: "origin", message: origin ? `Country ${origin} is not a valid ISO code` : "Country of origin is required" });
  const tariff = HTS[hts];
  if (!tariff) errors.push({ field: "hts", message: hts ? `HTS ${hts} is not a valid statistical reporting number` : "HTS number is required" });
  if (!(quantity > 0) || !Number.isInteger(quantity)) errors.push({ field: "quantity", message: "Quantity must be a whole number above zero" });
  if (!(value > 0)) errors.push({ field: "value", message: "Entered value must be above zero" });
  if (spi && !SPI[spi]) errors.push({ field: "spi", message: `SPI ${spi} is not supported on this line` });
  if (errors.length || !tariff) return { errors };

  const spiClears = !!spi && (SPI[spi] ?? []).includes(origin);
  if (spi && !spiClears) errors.push({ field: "spi", message: `SPI ${spi} does not apply to goods of ${COUNTRIES[origin]} origin` });
  if (errors.length) return { errors };
  const sums = totals(value, tariff.rate, mode, spiClears);
  return {
    errors,
    entry: {
      ref, port, portName: PORTS[port]!, mode, modeName: MODES[mode]!, importDate,
      ior, importer: IMPORTERS[ior]!.name, mid, carrier, carrierName: CARRIERS[carrier]!, bl,
      origin, originName: COUNTRIES[origin]!,
      line: { hts, description: tariff.description, quantity, unit: tariff.unit, value: round(value), rateText: tariff.rateText, spi, duty: sums.duty },
      totals: sums,
    },
  };
}

/** `MT9-0412871-6`: filer code, seven-digit entry number, check digit. */
export function entryNumber(sequence: number): string {
  const digits = String(sequence).padStart(7, "0");
  const all = [...FILER_CODE].map((c) => (/\d/.test(c) ? c : String((c.charCodeAt(0) - 64) % 10))).join("") + digits;
  let sum = 0;
  [...all].reverse().forEach((d, i) => {
    let n = Number(d);
    if (i % 2 === 0) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  });
  return `${FILER_CODE}-${digits}-${(10 - (sum % 10)) % 10}`;
}

const FIRST_SEQUENCE = 412870;

function storePath(): string {
  return process.env.OKIDOKI_ACE_FILE || join(process.env.HOME ?? ".", "Library", "Application Support", "Okidoki", "ace-entries.json");
}

export function loadEntries(): PortalEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(storePath(), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveEntries(entries: PortalEntry[]) {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(entries.slice(0, 500), null, 2));
}

function nextSequence(entries: PortalEntry[]): number {
  const used = entries.map((e) => Number(e.entryNumber.split("-")[1])).filter((n) => Number.isFinite(n));
  return Math.max(FIRST_SEQUENCE, ...used) + 1;
}

export function transmit(input: EntryInput, now = Date.now()): { ok: true; entry: PortalEntry } | { ok: false; errors: { field: string; message: string }[] } {
  const checked = validate(input);
  if (!checked.entry) return { ok: false, errors: checked.errors };
  const entries = loadEntries();
  const entry: PortalEntry = { ...checked.entry, entryNumber: entryNumber(nextSequence(entries)), status: "ACCEPTED", entryType: "01", transmittedAt: now };
  saveEntries([entry, ...entries]);
  return { ok: true, entry };
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** Handles /ace and everything under it; null for any other path. */
export async function portalRoute(request: Request, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (path !== "/ace" && !path.startsWith("/ace/")) return null;
  if (path === "/ace" || path === "/ace/") return Response.redirect(new URL("/ace/entry", url).toString(), 302);
  if (path === "/ace/entry" && request.method === "GET") {
    return new Response(page(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  if (path === "/ace/api/next" && request.method === "GET") {
    return json({ entryNumber: entryNumber(nextSequence(loadEntries())) });
  }
  if (path === "/ace/api/entries" && request.method === "GET") {
    const ref = (url.searchParams.get("ref") ?? "").trim().toUpperCase();
    const entries = loadEntries().filter((e) => !ref || e.ref === ref);
    return json(entries.slice(0, 50));
  }
  if (path === "/ace/api/entries" && request.method === "POST") {
    // Same-origin pages only: the workbench posts from /ace/entry on this host.
    const origin = request.headers.get("origin");
    if (origin && new URL(origin).host !== url.host) return json({ error: "forbidden" }, 403);
    let body: EntryInput;
    try {
      body = (await request.json()) as EntryInput;
    } catch {
      return json({ ok: false, errors: [{ field: "", message: "The entry could not be read" }] }, 400);
    }
    const result = transmit(body);
    return json(result, result.ok ? 200 : 422);
  }
  return json({ error: "not found" }, 404);
}

function page(): string {
  const reference = JSON.stringify({ IMPORTERS, PORTS, MODES, CARRIERS, COUNTRIES, HTS, FEES, SPI });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>New Entry Summary · Meridian Trade Services</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{--navy:#0d2240;--navy2:#16325c;--line:#d8dee8;--ink:#1b2430;--mute:#66758a;--bg:#f3f5f9;--ok:#127a46;--okbg:#e6f5ec;--bad:#b42318;--badbg:#fdecea;--accent:#1f6feb}
*{box-sizing:border-box}body{margin:0;font:13px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif;color:var(--ink);background:var(--bg)}
header{background:var(--navy);color:#fff;display:flex;align-items:center;gap:18px;padding:0 20px;height:52px}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;font-size:15px;letter-spacing:.2px}
.mark{width:28px;height:28px;border-radius:6px;background:linear-gradient(135deg,#3b82f6,#14b8a6);display:grid;place-items:center;font-size:12px;font-weight:800}
.brand small{display:block;font-weight:400;font-size:11px;color:#9fb3cf;letter-spacing:0}
nav{display:flex;gap:2px;margin-left:12px}nav a{color:#c9d6ea;text-decoration:none;padding:8px 12px;border-radius:6px;font-size:13px}nav a.on{background:var(--navy2);color:#fff}
.right{margin-left:auto;display:flex;align-items:center;gap:16px;font-size:12px;color:#c9d6ea}
.ace{display:flex;align-items:center;gap:6px;background:#0a1a31;border:1px solid #23406b;padding:4px 10px;border-radius:999px}
.dot{width:7px;height:7px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.18)}
main{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:18px;padding:18px 20px;max-width:1440px;margin:0 auto}
@media (max-width:1180px){main{grid-template-columns:minmax(0,1fr)}.pill{display:none}}
.card{background:#fff;border:1px solid var(--line);border-radius:10px}
.titlebar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:12px 18px;border-bottom:1px solid var(--line)}.titlebar h1,.titlebar .pill,.titlebar button,.entryno{white-space:nowrap}
.titlebar h1{font-size:16px;margin:0;white-space:nowrap}.pill{font-size:11px;padding:2px 8px;border-radius:999px;background:#eef2f8;color:var(--mute);border:1px solid var(--line)}
.entryno{margin-left:auto;margin-right:6px;font:600 13px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--navy)}
section{padding:10px 18px 4px;border-bottom:1px solid #eef1f6}section h2{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--mute);margin:0 0 8px}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px 14px}
.f label{display:block;font-size:11px;color:var(--mute);margin-bottom:3px}.f label b{color:#94a3b8;font-weight:500}
.f input{width:100%;height:32px;border:1px solid #c7d0dd;border-radius:6px;padding:0 9px;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink);background:#fff}
.f input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(31,111,235,.18)}
.f input[readonly]{background:#f6f8fb;color:#475569}
.f input.err{border-color:var(--bad);box-shadow:0 0 0 3px rgba(180,35,24,.12)}
.f .hint{min-height:16px;font-size:11px;color:var(--mute);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.f .hint.ok{color:var(--ok)}.f .hint.bad{color:var(--bad)}
.span2{grid-column:span 2}
.totals{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;padding:14px 18px;background:#fafbfd;border-bottom:1px solid #eef1f6}
.totals div{font-size:11px;color:var(--mute)}.totals strong{display:block;font:600 15px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink);margin-top:2px}
.totals .grand strong{color:var(--navy)}
.actions{display:flex;gap:10px;padding:10px 18px;align-items:center}
button{height:34px;padding:0 16px;border-radius:7px;border:1px solid #c7d0dd;background:#fff;font:600 13px -apple-system,sans-serif;color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button:disabled{opacity:.5;cursor:default}
.note{font-size:11px;color:var(--mute)}
#result{display:none;margin:12px 18px 0;border-radius:8px;padding:12px 14px;font-size:13px}
#result.ok{display:block;background:var(--okbg);border:1px solid #9bd3b2;color:#0b4f2d}#result.bad{display:block;background:var(--badbg);border:1px solid #f1a59d;color:#7a1a12}
#result h3{margin:0 0 6px;font-size:13px}#result ul{margin:4px 0 0 18px;padding:0}#result code{font:600 13px ui-monospace,Menlo,monospace}
aside .card{overflow:hidden}aside h2{font-size:12px;margin:0;padding:12px 14px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between}
table{width:100%;border-collapse:collapse;font-size:12px}td{padding:8px 14px;border-bottom:1px solid #eef1f6;vertical-align:top}
td.no{font:600 12px ui-monospace,Menlo,monospace;color:var(--navy)}td.amt{text-align:right;font-family:ui-monospace,Menlo,monospace}
.st{font-size:10px;font-weight:700;color:var(--ok);background:var(--okbg);padding:2px 6px;border-radius:4px}
.empty{padding:18px 14px;color:var(--mute);font-size:12px}
.flash{animation:flash 1.4s ease-out}@keyframes flash{from{background:#fff7d6}to{background:transparent}}
</style></head>
<body>
<header>
  <div class="brand"><div class="mark">MTS</div><div>Meridian Trade Services<small>Licensed U.S. Customs Broker · Filer ${FILER_CODE}</small></div></div>
  <nav><a class="on" href="/ace/entry">Entries</a><a href="#" onclick="return false">Shipments</a><a href="#" onclick="return false">Clients</a><a href="#" onclick="return false">Statements</a></nav>
  <div class="right"><span class="ace"><span class="dot"></span>ACE ABI · CERT</span><span>J. Katariya · Lic. 34127</span></div>
</header>
<main>
<div class="card">
  <div class="titlebar"><h1>New Entry Summary</h1><span class="pill">CBP Form 7501</span><span class="pill">Type 01 · Consumption</span><span class="entryno" id="entryno">Entry —</span>
    <button type="button" id="new" aria-label="New entry">New entry</button>
    <button type="button" id="validate" aria-label="Validate">Validate</button>
    <button type="button" class="primary" id="transmit" aria-label="Transmit to ACE">Transmit to ACE</button>
  </div>
  <div id="result" role="status" aria-live="polite"></div>
  <form id="form" autocomplete="off" onsubmit="return false">
  <section><h2>Entry</h2><div class="grid">
    ${field("ref", "Broker reference", "shipment file")}
    ${field("port", "Port of entry", "4-digit code")}
    ${field("mode", "Mode of transport", "code")}
    ${field("importDate", "Import date", "MM/DD/YYYY")}
  </div></section>
  <section><h2>Importer</h2><div class="grid">
    ${field("ior", "Importer number", "IRS / EIN", "span2")}
    ${field("mid", "Manufacturer ID", "MID", "span2")}
  </div></section>
  <section><h2>Transport</h2><div class="grid">
    ${field("carrier", "Carrier SCAC", "4 letters")}
    ${field("bl", "Bill of lading", "B/L or AWB")}
    ${field("origin", "Country of origin", "ISO code")}
    <div class="f"><label>Bond</label><input readonly tabindex="-1" value="Type 8 · surety 457 · continuous"><div class="hint">On file for all clients</div></div>
  </div></section>
  <section><h2>Line 001</h2><div class="grid">
    ${field("hts", "HTS number", "10 digits")}
    ${field("quantity", "Quantity", "")}
    ${field("value", "Entered value", "USD")}
    ${field("spi", "SPI", "optional")}
  </div></section>
  </form>
  <div class="totals">
    <div>Duty<strong id="t-duty">$0.00</strong></div>
    <div>MPF <span id="t-mpfnote"></span><strong id="t-mpf">$0.00</strong></div>
    <div>HMF<strong id="t-hmf">$0.00</strong></div>
    <div>Fees<strong id="t-fees">$0.00</strong></div>
    <div class="grand">Total due<strong id="t-total">$0.00</strong></div>
  </div>
  <div class="actions"><span class="note">MPF 0.3464% · min $34.58 · max $670.86 (FY2027, CBP Dec. 26-14) · HMF 0.125% ocean only</span></div>
</div>
<aside><div class="card"><h2><span>Recent entries</span><span id="count" class="pill">0</span></h2><div id="recent"><div class="empty">No entries transmitted yet.</div></div></div></aside>
</main>
<script>
var R = ${reference};
var F = ["ref","port","mode","importDate","ior","mid","carrier","bl","origin","hts","quantity","value","spi"];
function $(id){return document.getElementById(id)}
function v(id){return ($("f-"+id).value||"").trim()}
function money(n){return "$"+(Math.round(n*100)/100).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}
function hts(x){var d=x.replace(/\\D/g,"");return d.length===10?d.slice(0,4)+"."+d.slice(4,6)+"."+d.slice(6):x}
function hint(id,text,cls){var h=$("h-"+id);h.textContent=text||"";h.className="hint"+(cls?" "+cls:"")}
function look(){
  var p=R.PORTS[v("port")],m=R.MODES[v("mode")],i=R.IMPORTERS[v("ior")],c=R.CARRIERS[v("carrier").toUpperCase()],o=R.COUNTRIES[v("origin").toUpperCase()],t=R.HTS[hts(v("hts"))];
  hint("port",p||(v("port")?"unknown port":""),p?"ok":(v("port")?"bad":""));
  hint("mode",m||"",m?"ok":"");
  hint("ior",i?i.name+" · "+i.address:(v("ior").length>12?"not on file":""),i?"ok":(v("ior").length>12?"bad":""));
  hint("carrier",c||"",c?"ok":"");
  hint("origin",o||"",o?"ok":"");
  hint("hts",t?t.rateText+" · "+t.description:"",t?"ok":"");
  hint("quantity",t?t.unit:"");
  var spi=v("spi").toUpperCase(),org=v("origin").toUpperCase();
  hint("spi",spi?((R.SPI[spi]||[]).indexOf(org)>=0?"USMCA · duty free":"not for this origin"):"",spi?((R.SPI[spi]||[]).indexOf(org)>=0?"ok":"bad"):"");
  var val=Number(v("value").replace(/[$,\\s]/g,""))||0,rate=t?t.rate:0,mode=v("mode");
  hint("value",val?money(val):"");
  var clears=spi&&(R.SPI[spi]||[]).indexOf(org)>=0;
  var duty=clears?0:Math.round(val*rate*100)/100;
  var mpf=val?Math.round(Math.min(R.FEES.mpfMax,Math.max(R.FEES.mpfMin,val*R.FEES.mpfRate))*100)/100:0;
  var hmf=val&&mode.charAt(0)==="1"?Math.round(val*R.FEES.hmfRate*100)/100:0;
  $("t-duty").textContent=money(duty);$("t-mpf").textContent=money(mpf);$("t-hmf").textContent=money(hmf);
  $("t-fees").textContent=money(mpf+hmf);$("t-total").textContent=money(duty+mpf+hmf);
  $("t-mpfnote").textContent=val&&mpf===R.FEES.mpfMin?"(min)":val&&mpf===R.FEES.mpfMax?"(max)":"";
}
function payload(){var o={};F.forEach(function(k){o[k]=v(k)});return o}
function clearErrs(){F.forEach(function(k){$("f-"+k).classList.remove("err")})}
function showErrors(errs){
  clearErrs();errs.forEach(function(e){if(e.field&&$("f-"+e.field))$("f-"+e.field).classList.add("err")});
  var r=$("result");r.className="bad";r.innerHTML="<h3>ACE rejected the entry · "+errs.length+" error"+(errs.length===1?"":"s")+"</h3><ul>"+errs.map(function(e){return "<li>"+e.message+"</li>"}).join("")+"</ul>";
}
function localCheck(){
  var e=[];F.forEach(function(k){if(k!=="spi"&&!v(k))e.push({field:k,message:$("l-"+k).textContent+" is required"})});
  if(v("hts")&&!R.HTS[hts(v("hts"))])e.push({field:"hts",message:"HTS "+v("hts")+" is not a valid statistical reporting number"});
  if(v("ior")&&!R.IMPORTERS[v("ior")])e.push({field:"ior",message:"Importer "+v("ior")+" is not on file"});
  return e;
}
function next(){fetch("/ace/api/next").then(function(r){return r.json()}).then(function(d){$("entryno").textContent="Entry "+d.entryNumber})}
function recent(flash){
  fetch("/ace/api/entries").then(function(r){return r.json()}).then(function(list){
    $("count").textContent=list.length;
    if(!list.length){$("recent").innerHTML='<div class="empty">No entries transmitted yet.</div>';return}
    $("recent").innerHTML="<table>"+list.slice(0,14).map(function(e,i){
      var when=new Date(e.transmittedAt);
      return "<tr"+(flash&&i===0?' class="flash"':"")+"><td class=no>"+e.entryNumber+"<br><span style=\\"font:400 11px -apple-system;color:#66758a\\">"+e.ref+" · "+e.importer+"</span></td><td class=amt>"+money(e.totals.total)+"<br><span class=st>"+e.status+"</span></td></tr>";
    }).join("")+"</table>";
  });
}
$("validate").onclick=function(){
  var e=localCheck();if(e.length)return showErrors(e);clearErrs();
  var r=$("result");r.className="ok";r.innerHTML="<h3>Validated · no errors</h3>Ready to transmit "+v("ref").toUpperCase()+" for "+(R.IMPORTERS[v("ior")]||{}).name+".";
};
$("transmit").onclick=function(){
  var b=$("transmit");b.disabled=true;b.textContent="Transmitting…";
  fetch("/ace/api/entries",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload())})
  .then(function(r){return r.json()}).then(function(d){
    b.disabled=false;b.textContent="Transmit to ACE";
    if(!d.ok)return showErrors(d.errors||[{message:"Transmission failed"}]);
    clearErrs();var e=d.entry,r=$("result");r.className="ok";
    r.innerHTML="<h3>ACE response · ACCEPTED</h3>Entry <code>"+e.entryNumber+"</code> · "+e.ref+" · "+e.importer+"<br>Summary accepted (SA) · Cargo release: <b>RELEASED</b> · Duty "+money(e.totals.duty)+" · Fees "+money(e.totals.fees)+" · Total "+money(e.totals.total)+" on the daily statement";
    $("entryno").textContent="Entry "+e.entryNumber;recent(true);
  }).catch(function(){b.disabled=false;b.textContent="Transmit to ACE";showErrors([{message:"Could not reach ACE. Try again."}])});
};
$("new").onclick=function(){$("form").reset();clearErrs();$("result").className="";look();next();$("f-ref").focus()};
F.forEach(function(k){$("f-"+k).addEventListener("input",look)});
look();next();recent(false);
</script>
</body></html>`;
}

function field(id: string, label: string, hint: string, cls = ""): string {
  // The label is exactly the field's name: replays find fields by their accessible name.
  return `<div class="f ${cls}"><label id="l-${id}" for="f-${id}">${label}</label>`
    + `<input id="f-${id}" name="mts_${id}" aria-label="${label}" placeholder="${hint}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">`
    + `<div class="hint" id="h-${id}"></div></div>`;
}
