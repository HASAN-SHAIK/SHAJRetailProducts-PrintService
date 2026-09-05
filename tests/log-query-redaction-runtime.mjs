import { spawn } from "node:child_process";
import http from "node:http";
import process from "node:process";

const port = 43134;
const marker = "SHAJ_FAKE_SECRET_QUERY_MARKER_43134";
const server = spawn(process.execPath, ["server.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    CORS_ORIGIN: "https://pos.shajtech.in",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
server.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

const request = (path) =>
  new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: "127.0.0.1", port, path, timeout: 1500 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
  });

const waitForServer = async () => {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(
        `PrintService exited before readiness: code=${server.exitCode}\n${stdout}\n${stderr}`,
      );
    }
    try {
      const response = await request("/status");
      if (response.status === 200) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error("PrintService did not become ready");
};

const stopServer = async () => {
  if (server.exitCode !== null) return;
  server.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => server.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  if (server.exitCode === null) server.kill("SIGKILL");
};

let failure;
try {
  await waitForServer();

  const sensitivePath = `/status?sync_token=${marker}&receipt_id=INV-SECRET-42`;
  const response = await request(sensitivePath);
  const body = JSON.parse(response.body);

  console.log(`PRINTSERVICE_QUERY_STATUS=${response.status}`);
  console.log(`PRINTSERVICE_QUERY_CONNECTED=${body.connected === true}`);
  console.log(`PRINTSERVICE_PROCESS_ALIVE_AFTER_QUERY=${server.exitCode === null}`);

  if (response.status !== 200 || body.connected !== true) {
    throw new Error("real /status request did not complete successfully");
  }

  await new Promise((resolve) => setTimeout(resolve, 150));
} catch (error) {
  failure = error;
} finally {
  await stopServer();
}

const combinedLogs = `${stdout}\n${stderr}`;
const secretLeaked = combinedLogs.includes(marker);
const receiptLeaked = combinedLogs.includes("INV-SECRET-42");

console.log(`PRINTSERVICE_QUERY_MARKER_LOGGED=${secretLeaked}`);
console.log(`PRINTSERVICE_RECEIPT_ID_LOGGED=${receiptLeaked}`);
console.log(
  `PRINTSERVICE_QUERY_LOG_REDACTION_PASS=${!secretLeaked && !receiptLeaked}`,
);

if (failure) throw failure;
if (secretLeaked || receiptLeaked) {
  throw new Error(
    "request query parameters were written verbatim to PrintService logs",
  );
}
