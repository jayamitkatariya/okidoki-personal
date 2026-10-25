import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "okidoki-ace-"));
process.env.OKIDOKI_ACE_FILE = join(dir, "entries.json");
process.env.OKIDOKI_BRAIN_TOKEN = crypto.randomUUID();
const { handleRequest } = await import("../src/server");
const { entryNumber, totals, validate } = await import("../src/portal");
const { parseAnswer, resolvePdf } = await import("../src/finder");
const base = "http://127.0.0.1:4319";
const call = (path: string, init?: RequestInit) => handleRequest(new Request(base + path, init));

const laptops = {
  ref: "MTS-4471", port: "4601", mode: "11", importDate: "10/22/2026", ior: "16-4827193-00", mid: "TWQUACOM211TAO",
  carrier: "MAEU", bl: "MAEU264817736", origin: "TW", hts: "8471.30.0100", quantity: "240", value: "146880", spi: "",
};

beforeEach(() => rmSync(process.env.OKIDOKI_ACE_FILE!, { force: true }));

test("the workbench page needs no token, everything else still does", async () => {
  const page = await call("/ace/entry");
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain("Transmit to ACE");
  expect(html).toContain('aria-label="Broker reference"');
  expect((await call("/ace")).status).toBe(302);
  expect((await call("/health")).status).toBe(401);
  expect((await call("/find/document", { method: "POST", body: "{}" })).status).toBe(401);
});

test("transmitting prices the entry with FY2027 fees and keeps it", async () => {
  const sent = await call("/ace/api/entries", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify(laptops) });
  expect(sent.status).toBe(200);
  const { entry } = (await sent.json()) as { entry: { entryNumber: string; totals: Record<string, number>; importer: string } };
  // 146,880 × 0.3464% = 508.79 (inside the $34.58–$670.86 band); HMF 0.125% on ocean = 183.60; laptops are free.
  expect(entry.totals).toEqual({ duty: 0, mpf: 508.79, hmf: 183.6, fees: 692.39, total: 692.39 });
  expect(entry.importer).toBe("Lakeshore Electronics Inc.");
  expect(entry.entryNumber).toBe(entryNumber(412871));
  const listed = (await (await call("/ace/api/entries?ref=mts-4471")).json()) as { entryNumber: string }[];
  expect(listed.map((e) => e.entryNumber)).toEqual([entry.entryNumber]);
  const second = (await (await call("/ace/api/entries", { method: "POST", body: JSON.stringify({ ...laptops, ref: "MTS-4472" }) })).json()) as { entry: { entryNumber: string } };
  expect(second.entry.entryNumber).toBe(entryNumber(412872));
});

test("a bad entry comes back with the broker's errors and isn't kept", async () => {
  const sent = await call("/ace/api/entries", { method: "POST", body: JSON.stringify({ ...laptops, hts: "8507.60.0020", ior: "99-0000000-00" }) });
  expect(sent.status).toBe(422);
  const body = (await sent.json()) as { ok: boolean; errors: { field: string }[] };
  expect(body.ok).toBe(false);
  expect(body.errors.map((e) => e.field).sort()).toEqual(["hts", "ior"]);
  expect(await (await call("/ace/api/entries")).json()).toEqual([]);
});

test("another site can't post entries", async () => {
  const sent = await call("/ace/api/entries", { method: "POST", headers: { origin: "https://evil.example" }, body: JSON.stringify(laptops) });
  expect(sent.status).toBe(403);
});

test("duty, minimum MPF and USMCA", () => {
  expect(totals(69300, 0.034, "11", false)).toEqual({ duty: 2356.2, mpf: 240.06, hmf: 86.63, fees: 326.69, total: 2682.89 });
  expect(totals(5000, 0.034, "30", false)).toEqual({ duty: 170, mpf: 34.58, hmf: 0, fees: 34.58, total: 204.58 });
  expect(totals(500000, 0, "30", false).mpf).toBe(670.86);
  const usmca = validate({ ...laptops, origin: "CA", mode: "30", hts: "3924.10.4000", spi: "S", value: "41250" });
  expect(usmca.entry?.totals.duty).toBe(0);
  expect(validate({ ...laptops, spi: "S" }).errors[0]?.field).toBe("spi");
});

test("entry numbers carry a stable check digit", () => {
  expect(entryNumber(412871)).toMatch(/^MT9-0412871-\d$/);
  expect(entryNumber(412871)).toBe(entryNumber(412871));
  expect(entryNumber(412871)).not.toBe(entryNumber(412872));
});

test("the finder reads the model's answer and follows a landing page to its PDF", async () => {
  expect(parseAnswer('Here: {"title": "CBP Form 3461", "url": "https://www.cbp.gov/document/forms/form-3461"}')).toEqual({ title: "CBP Form 3461", url: "https://www.cbp.gov/document/forms/form-3461" });
  expect(parseAnswer('{"title": "", "url": ""}')).toBeNull();
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/form-3461")) {
      return new Response('<a href="/sites/default/files/2025-01/cbp_form_3461.pdf">CBP Form 3461</a><a href="/other.pdf">Privacy</a>', { headers: { "content-type": "text/html" } });
    }
    if (url.endsWith(".pdf") && init?.method === "HEAD") return new Response(null, { headers: { "content-type": "application/pdf" } });
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  expect(await resolvePdf("https://www.cbp.gov/document/forms/form-3461", "cbp form 3461", fake)).toBe("https://www.cbp.gov/sites/default/files/2025-01/cbp_form_3461.pdf");
});
