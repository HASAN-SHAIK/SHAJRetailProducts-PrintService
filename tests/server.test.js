"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { loadServer } = require("./helpers");

async function withServer(env, fn) {
  const s = loadServer(env);
  const { server, url } = await s.listen();
  try {
    await fn(s, url);
  } finally {
    await new Promise((r) => server.close(r));
    s.restore();
  }
}

const post = (url, body) =>
  fetch(`${url}/print`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const printCalls = (s) => s.calls.filter((c) => /-print-to/.test(c));

test("GET /status reports connected + printer name", () =>
  withServer({}, async (s, url) => {
    const res = await fetch(`${url}/status`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      connected: true,
      printer: "TestPrinter",
      mode: "windows-spooler",
    });
  }));

test("GET /printers lists printers from stubbed spooler", () =>
  withServer({}, async (s, url) => {
    s.setPrinters(["A", "B"]);
    assert.deepEqual(await (await fetch(`${url}/printers`)).json(), {
      printers: ["A", "B"],
    });
  }));

test("POST /print happy path: writes temp file, invokes stubbed SumatraPDF", () =>
  withServer({}, async (s, url) => {
    const res = await post(url, {
      shopName: "SHAJ",
      billNo: "B1",
      items: [{ name: "Tea", qty: 1, rate: 10 }],
      total: 10,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true });
    const cmds = printCalls(s);
    assert.equal(cmds.length, 1);
    assert.match(cmds[0], /-print-to "TestPrinter"/);
    assert.match(cmds[0], /-silent/);
    assert.ok(cmds[0].includes(s.tempPath));
    const written = fs.readFileSync(s.tempPath, "utf8");
    assert.match(written, /Bill No: B1/);
    assert.match(written, /TOTAL: 10/);
  }));

test("POST /print honours paperWidth 80 in the spooled file", () =>
  withServer({}, async (s, url) => {
    await post(url, { shopName: "X", printConfig: { paperWidth: 80 } });
    const written = fs.readFileSync(s.tempPath, "utf8");
    assert.ok(written.includes("-".repeat(48)));
    assert.ok(!written.includes("-".repeat(49)));
  }));

test("temp file is overwritten per print, not accumulated", () =>
  withServer({}, async (s, url) => {
    await post(url, { shopName: "First", billNo: "AAA" });
    await post(url, { shopName: "Second", billNo: "BBB" });
    const written = fs.readFileSync(s.tempPath, "utf8");
    assert.match(written, /BBB/);
    assert.doesNotMatch(written, /AAA/);
  }));

test("POST /print: unknown printer => 400 with printer list, nothing printed", () =>
  withServer({}, async (s, url) => {
    s.setPrinters(["Other"]);
    const res = await post(url, { shopName: "X" });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /Printer not found/);
    assert.deepEqual(body.printers, ["Other"]);
    assert.equal(printCalls(s).length, 0);
  }));

test("POST /print: missing SumatraPDF => 500 with hint, nothing printed", () =>
  withServer({ SUMATRA_PATH: "Z:\\nope\\Sumatra.exe" }, async (s, url) => {
    const res = await post(url, { shopName: "X" });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /SumatraPDF not found/);
    assert.equal(s.calls.length, 0);
  }));

test("POST /print: spooler failure => 500 with message", () =>
  withServer({}, async (s, url) => {
    s.setPrintError(new Error("spooler down"));
    const res = await post(url, { shopName: "X" });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "spooler down" });
  }));

test("POST /print: malformed JSON => 400, server keeps serving", () =>
  withServer({}, async (s, url) => {
    const res = await post(url, "{not json");
    assert.equal(res.status, 400);
    assert.equal((await fetch(`${url}/status`)).status, 200);
    assert.equal(printCalls(s).length, 0);
  }));

test("POST /print: payload over 1mb => 413, nothing printed", () =>
  withServer({}, async (s, url) => {
    const res = await post(url, { shopName: "x".repeat(1024 * 1024 + 10) });
    assert.equal(res.status, 413);
    assert.equal(printCalls(s).length, 0);
  }));

test("POST /print: hostile payload shapes never crash the service", () =>
  withServer({}, async (s, url) => {
    for (const body of [
      {},
      { items: "nope" },
      { items: [null] },
      { items: [{ name: 5, qty: "x", rate: {} }] },
    ]) {
      const res = await post(url, body);
      assert.ok([200, 500].includes(res.status), `status ${res.status}`);
    }
    assert.equal((await fetch(`${url}/status`)).status, 200);
  }));

// Documents current behaviour: an empty body is NOT rejected; it prints a
// default "My Store" receipt. Flip to 400 if input validation is ever added.
test(
  "POST /print: empty payload should be rejected with 4xx",
  { todo: "no validation today: {} prints a default receipt (200)" },
  () =>
    withServer({}, async (s, url) => {
      const res = await post(url, {});
      assert.ok(res.status >= 400 && res.status < 500);
    }),
);

test("CORS: allowed origin echoed, disallowed origin rejected", () =>
  withServer({}, async (s, url) => {
    const ok = await fetch(`${url}/status`, {
      headers: { Origin: "http://localhost:3000" },
    });
    assert.equal(
      ok.headers.get("access-control-allow-origin"),
      "http://localhost:3000",
    );
    const bad = await fetch(`${url}/status`, {
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(bad.status, 500);
    assert.equal(bad.headers.get("access-control-allow-origin"), null);
  }));

test("unknown route => 404", () =>
  withServer({}, async (s, url) => {
    assert.equal((await fetch(`${url}/nope`)).status, 404);
  }));
