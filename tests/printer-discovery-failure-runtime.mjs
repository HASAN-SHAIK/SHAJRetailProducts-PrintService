import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const port = 43139;
const fixtureDir = path.join(os.tmpdir(), `shaj-printservice-discovery-failure-${process.pid}`);
const powershellPath = path.join(fixtureDir, "powershell");
const sumatraPath = path.join(fixtureDir, "sumatra-fake.sh");
const sumatraMarker = path.join(fixtureDir, "sumatra-called.txt");

mkdirSync(fixtureDir, { recursive: true });
writeFileSync(
  powershellPath,
  "#!/usr/bin/env bash\nset -euo pipefail\necho 'simulated Get-Printer failure' >&2\nexit 17\n",
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
    PRINTER_NAME: "Cycle D Configured POS Printer",
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
      { hostname: "127.0.0.1", port, method, path: requestPath, headers, timeout: 2500 },
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

  const printersResponse = await request("GET", "/printers");
  const printersParsed = JSON.parse(printersResponse.body);

  const printBody = JSON.stringify({
    billNo: "CYCLE-D-DISCOVERY-FAILURE-001",
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

  const sumatraCalled = existsSync(sumatraMarker);
  const processAliveAfter = child.exitCode === null;
  const healthAfter = await request("GET", "/status");

  console.log(`PRINTSERVICE_DISCOVERY_FAILURE_PRINTERS_STATUS=${printersResponse.status}`);
  console.log(`PRINTSERVICE_DISCOVERY_FAILURE_PRINTERS=${JSON.stringify(printersParsed.printers || [])}`);
  console.log(`PRINTSERVICE_DISCOVERY_FAILURE_PRINT_STATUS=${printResponse.status}`);
  console.log(`PRINTSERVICE_DISCOVERY_FAILURE_PRINT_BODY=${printResponse.body}`);
  console.log(`PRINTSERVICE_SUMATRA_CALLED_AFTER_DISCOVERY_FAILURE=${sumatraCalled}`);
  console.log(`PRINTSERVICE_PROCESS_ALIVE_AFTER_DISCOVERY_FAILURE=${processAliveAfter}`);
  console.log(`PRINTSERVICE_STATUS_AFTER_DISCOVERY_FAILURE=${healthAfter.status}`);

  if (printersResponse.status !== 200 || !Array.isArray(printersParsed.printers) || printersParsed.printers.length !== 0) {
    throw new Error(`expected failed discovery to surface as current empty-list contract: ${printersResponse.body}`);
  }
  if (sumatraCalled) {
    throw new Error(`printer discovery failed, but production still launched Sumatra; printStatus=${printResponse.status}`);
  }
  if (printResponse.status < 400) {
    throw new Error(`printer discovery failed, but /print reported success: ${printResponse.status} ${printResponse.body}`);
  }
  if (!processAliveAfter || healthAfter.status !== 200) {
    throw new Error("PrintService did not remain healthy after discovery failure");
  }

  console.log("PRINTSERVICE_DISCOVERY_FAILURE_RUNTIME_PASS=true");
} catch (error) {
  failure = error;
} finally {
  await stopServer();
  rmSync(fixtureDir, { recursive: true, force: true });
}

if (failure) throw failure;
