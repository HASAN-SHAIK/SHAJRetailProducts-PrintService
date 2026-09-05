import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const port = 43135;
const cwd = process.cwd();
const fakeSumatra = path.join(cwd, "tests", "fake-sumatra-concurrency.sh");
const spoolDir = mkdtempSync(path.join(os.tmpdir(), "shaj-print-concurrency-"));
chmodSync(fakeSumatra, 0o755);

const server = spawn(process.execPath, ["server.js"], {
  cwd,
  env: {
    ...process.env,
    PORT: String(port),
    SUMATRA_PATH: fakeSumatra,
    PRINTER_NAME: "Virtual POS58",
    PRINTSERVICE_SPOOL_DIR: spoolDir,
    CORS_ORIGIN: "https://pos.shajtech.in",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
server.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
server.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

const get = (pathname) => new Promise((resolve, reject) => {
  const req = http.get({ hostname: "127.0.0.1", port, path: pathname, timeout: 2000 }, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => { body += chunk; });
    res.on("end", () => resolve({ status: res.statusCode, body }));
  });
  req.on("timeout", () => req.destroy(new Error("GET timeout")));
  req.on("error", reject);
});

const postPrint = (payload) => new Promise((resolve, reject) => {
  const body = JSON.stringify(payload);
  const req = http.request({
    hostname: "127.0.0.1",
    port,
    path: "/print",
    method: "POST",
    timeout: 5000,
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    },
  }, (res) => {
    let responseBody = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => { responseBody += chunk; });
    res.on("end", () => resolve({ status: res.statusCode, body: responseBody }));
  });
  req.on("timeout", () => req.destroy(new Error("POST timeout")));
  req.on("error", reject);
  req.end(body);
});

const waitFor = async (predicate, label, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
};

const waitForServer = async () => {
  await waitFor(() => server.exitCode === null, "server process");
  let lastError;
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await get("/status");
      if (response.status === 200) return;
    } catch (error) {
      lastError = error;
    }
    if (server.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError || new Error(`PrintService failed to start: ${stdout}\n${stderr}`);
};

const stopServer = async () => {
  if (server.exitCode !== null) return;
  server.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => server.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]);
  if (server.exitCode === null) server.kill("SIGKILL");
};

const firstBill = "CONCURRENT-FIRST-43135";
const secondBill = "CONCURRENT-SECOND-43135";
let firstStatus = null;
let secondStatus = null;
let processAlive = false;
let spools = [];
let failure = null;

try {
  await waitForServer();

  const firstPromise = postPrint({
    shopName: "Concurrency Shop A",
    billNo: firstBill,
    items: [{ name: "Tea", qty: 1, rate: 10 }],
    subtotal: 10,
    total: 10,
  });

  await waitFor(
    () => readdirSync(spoolDir).some((name) => name.startsWith("started-")),
    "first virtual spool invocation",
  );

  const secondPromise = postPrint({
    shopName: "Concurrency Shop B",
    billNo: secondBill,
    items: [{ name: "Coffee", qty: 1, rate: 20 }],
    subtotal: 20,
    total: 20,
  });

  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  firstStatus = first.status;
  secondStatus = second.status;

  await waitFor(
    () => readdirSync(spoolDir).filter((name) => name.startsWith("spool-") && name.endsWith(".txt")).length === 2,
    "two virtual spool outputs",
  );

  processAlive = server.exitCode === null;
  spools = readdirSync(spoolDir)
    .filter((name) => name.startsWith("spool-") && name.endsWith(".txt"))
    .sort()
    .map((name) => ({ name, text: readFileSync(path.join(spoolDir, name), "utf8") }));

  if (first.status !== 200 || second.status !== 200) {
    throw new Error(`expected both print requests to return 200, got ${first.status}/${second.status}`);
  }
  if (!processAlive) throw new Error("PrintService exited during concurrent requests");

  const firstCopies = spools.filter((entry) => entry.text.includes(firstBill)).length;
  const secondCopies = spools.filter((entry) => entry.text.includes(secondBill)).length;
  const isolated = firstCopies === 1 && secondCopies === 1;

  console.log(`PRINTSERVICE_CONCURRENT_FIRST_STATUS=${firstStatus}`);
  console.log(`PRINTSERVICE_CONCURRENT_SECOND_STATUS=${secondStatus}`);
  console.log(`PRINTSERVICE_CONCURRENT_PROCESS_ALIVE=${processAlive}`);
  console.log(`PRINTSERVICE_CONCURRENT_FIRST_COPIES=${firstCopies}`);
  console.log(`PRINTSERVICE_CONCURRENT_SECOND_COPIES=${secondCopies}`);
  console.log(`PRINTSERVICE_CONCURRENT_ISOLATION_PASS=${isolated}`);

  if (!isolated) {
    throw new Error(
      `concurrent print jobs were not isolated: firstCopies=${firstCopies}, secondCopies=${secondCopies}`,
    );
  }
} catch (error) {
  failure = error;
} finally {
  await stopServer();
}

const evidence = {
  firstStatus,
  secondStatus,
  processAlive,
  spoolCount: spools.length,
  firstBillCopies: spools.filter((entry) => entry.text.includes(firstBill)).length,
  secondBillCopies: spools.filter((entry) => entry.text.includes(secondBill)).length,
  isolated: spools.filter((entry) => entry.text.includes(firstBill)).length === 1 &&
    spools.filter((entry) => entry.text.includes(secondBill)).length === 1,
  spoolSummaries: spools.map((entry) => ({
    name: entry.name,
    containsFirstBill: entry.text.includes(firstBill),
    containsSecondBill: entry.text.includes(secondBill),
  })),
  runtimeFailure: failure ? failure.message : null,
};
writeFileSync("runtime-evidence.json", `${JSON.stringify(evidence, null, 2)}\n`);
rmSync(spoolDir, { recursive: true, force: true });

if (failure) throw failure;
