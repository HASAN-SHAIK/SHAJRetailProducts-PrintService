import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const port = 43138;
const fixtureDir = path.join(os.tmpdir(), `shaj-printservice-missing-printer-${process.pid}`);
const powershellPath = path.join(fixtureDir, "powershell");
const sumatraPath = path.join(fixtureDir, "sumatra-fake.sh");
const sumatraMarker = path.join(fixtureDir, "sumatra-called.txt");

mkdirSync(fixtureDir, { recursive: true });
writeFileSync(
  powershellPath,
  "#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' 'Office Laser Printer' 'Warehouse Label Printer'\n",
  "utf8",
);
writeFileSync(
  sumatraPath,
  `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "$*" > ${JSON.stringify(sumatraMarker)}\nexit 0\n`,
  "utf8",
);
chmodSync(powershellPath, 0o755);
chmodSync(sumatraPath, 0o755);

const child = spawn(process.execPath, ["server.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    PRINTER_NAME: "Cycle D Missing POS Printer",
    SUMATRA_PATH: sumatraPath,
    PATH: `${fixtureDir}${path.delimiter}${process.env.PATH || ""}`,
    CORS_ORIGIN: "https://pos.shajtech.in",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
  process.stderr.write(chunk);
});

const request = (method, requestPath, body, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, method, path: requestPath, headers, timeout: 2000 },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForReady() {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`PrintService exited before readiness: code=${child.exitCode}\n${stdout}\n${stderr}`);
    }
    try {
      const response = await request("GET", "/status");
      if (response.status === 200) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw lastError || new Error("PrintService did not become ready");
}

async function stopServer() {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(1500),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

let failure;
try {
  await waitForReady();

  const printBody = JSON.stringify({
    billNo: "CYCLE-D-MISSING-PRINTER-001",
    shopName: "Cycle D Store",
    items: [{ name: "Test Item", qty: 1, rate: 25 }],
    subtotal: 25,
    gst: 0,
    discount: 0,
    total: 25,
  });

  const printResponse = await request("POST", "/print", printBody, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(printBody),
  });
  const parsed = JSON.parse(printResponse.body);
  const sumatraCalled = existsSync(sumatraMarker);
  const processAliveAfter = child.exitCode === null;
  const healthAfter = await request("GET", "/status");

  console.log(`PRINTSERVICE_MISSING_PRINTER_STATUS=${printResponse.status}`);
  console.log(`PRINTSERVICE_MISSING_PRINTER_ERROR=${parsed.error || ""}`);
  console.log(`PRINTSERVICE_MISSING_PRINTER_LIST=${JSON.stringify(parsed.printers || [])}`);
  console.log(`PRINTSERVICE_SUMATRA_CALLED_ON_MISSING_PRINTER=${sumatraCalled}`);
  console.log(`PRINTSERVICE_PROCESS_ALIVE_AFTER_MISSING_PRINTER=${processAliveAfter}`);
  console.log(`PRINTSERVICE_STATUS_AFTER_MISSING_PRINTER=${healthAfter.status}`);

  if (printResponse.status !== 400) {
    throw new Error(`expected HTTP 400 for configured printer missing from discovery, got ${printResponse.status}`);
  }
  if (parsed.error !== "Printer not found: Cycle D Missing POS Printer") {
    throw new Error(`unexpected missing-printer error contract: ${printResponse.body}`);
  }
  if (!Array.isArray(parsed.printers) || parsed.printers.length !== 2) {
    throw new Error(`expected discovered printer list in error response: ${printResponse.body}`);
  }
  if (!parsed.printers.includes("Office Laser Printer") || !parsed.printers.includes("Warehouse Label Printer")) {
    throw new Error(`discovery output was not preserved: ${printResponse.body}`);
  }
  if (sumatraCalled) {
    throw new Error("Sumatra was launched even though the configured printer was not discovered");
  }
  if (!processAliveAfter || healthAfter.status !== 200) {
    throw new Error("PrintService did not remain healthy after missing-printer rejection");
  }

  console.log("PRINTSERVICE_MISSING_PRINTER_RUNTIME_PASS=true");
} catch (error) {
  failure = error;
} finally {
  await stopServer();
  rmSync(fixtureDir, { recursive: true, force: true });
}

if (failure) throw failure;
