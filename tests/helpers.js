"use strict";
// Test helpers: load server.js with a controlled env and a stubbed child_process.
// Nothing here ever spawns a real process: exec is replaced before any request.
const os = require("os");
const path = require("path");
const fs = require("fs");
const childProcess = require("child_process");

const SERVER = path.join(__dirname, "..", "server.js");

function loadServer(env = {}) {
  const saved = {};
  const base = {
    PRINTER_NAME: "TestPrinter",
    SUMATRA_PATH: process.execPath, // any file that exists
    CORS_ORIGIN: "http://localhost:3000",
    USE_ESC_POS: "",
    CENTER_HEADER: "",
    LEFT_MARGIN_SPACES: "",
    SUMATRA_PRINT_SETTINGS: "",
    PORT: "",
    RECEIPT_TEMP_PATH: path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "printsvc-")),
      "temp.txt",
    ),
  };
  const merged = { ...base, ...env };
  for (const [k, v] of Object.entries(merged)) {
    saved[k] = process.env[k];
    // Set to "" (not delete): server.js calls dotenv, which fills in any variable
    // that is absent, so a developer's local .env would leak into the tests.
    // dotenv never overrides a variable that already exists.
    process.env[k] = v === undefined ? "" : v;
  }
  delete require.cache[require.resolve(SERVER)];
  const mod = require(SERVER);

  const calls = [];
  const realExec = childProcess.exec;
  let printers = ["TestPrinter"];
  let printError = null;
  childProcess.exec = (cmd, cb) => {
    calls.push(cmd);
    if (/Get-Printer/.test(cmd)) cb(null, printers.join("\r\n"));
    else cb(printError, "");
  };

  return {
    ...mod,
    tempPath: merged.RECEIPT_TEMP_PATH,
    calls,
    setPrinters: (p) => (printers = p),
    setPrintError: (e) => (printError = e),
    async listen() {
      const server = await new Promise((resolve) => {
        const s = mod.app.listen(0, "127.0.0.1", () => resolve(s));
      });
      return { server, url: `http://127.0.0.1:${server.address().port}` };
    },
    restore() {
      childProcess.exec = realExec;
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      delete require.cache[require.resolve(SERVER)];
      try {
        fs.rmSync(path.dirname(merged.RECEIPT_TEMP_PATH), {
          recursive: true,
          force: true,
        });
      } catch {}
    },
  };
}

module.exports = { loadServer };
