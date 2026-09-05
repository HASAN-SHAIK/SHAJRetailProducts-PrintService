import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const port = Number(process.env.TEST_PORT || 43134);
const base = `http://127.0.0.1:${port}`;
const fakeSumatra = path.join(root, 'tests', 'fake-sumatra-hang.sh');
const fakeLog = path.join(process.env.RUNNER_TEMP || '/tmp', `shaj-fake-sumatra-${process.pid}.log`);
const timeoutMs = Number(process.env.PRINT_RESPONSE_DEADLINE_MS || 2500);

fs.writeFileSync(fakeLog, '');

const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  detached: true,
  env: {
    ...process.env,
    PORT: String(port),
    PRINTER_NAME: 'POSPrinter POS58',
    SUMATRA_PATH: fakeSumatra,
    FAKE_SUMATRA_LOG: fakeLog,
    FAKE_SUMATRA_SLEEP_SECONDS: '30',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverOutput = '';
server.stdout.on('data', (d) => { serverOutput += d.toString(); });
server.stderr.on('data', (d) => { serverOutput += d.toString(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForStatus() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`${base}/status`);
      if (res.status === 200) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`PrintService did not become ready. Output:\n${serverOutput}`);
}

async function waitForSpoolStart() {
  for (let i = 0; i < 30; i += 1) {
    const text = fs.readFileSync(fakeLog, 'utf8');
    if (text.includes('FAKE_SUMATRA_STARTED=true')) return;
    await sleep(100);
  }
  throw new Error(`virtual spooler did not start. Output:\n${serverOutput}`);
}

let requestSettled = false;
let responseStatus = null;
let responseBody = '';
let abortedByDeadline = false;

try {
  await waitForStatus();

  const controller = new AbortController();
  const timer = setTimeout(() => {
    abortedByDeadline = true;
    controller.abort();
  }, timeoutMs);

  const printPromise = fetch(`${base}/print`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      shopName: 'SHAJ Runtime Store',
      billNo: 'HANG-001',
      payment: 'cash',
      items: [{ name: 'Test Item', qty: 1, rate: 10 }],
      subtotal: 10,
      gst: 0,
      discount: 0,
      total: 10,
    }),
    signal: controller.signal,
  }).then(async (res) => {
    requestSettled = true;
    responseStatus = res.status;
    responseBody = await res.text();
  }).catch((err) => {
    if (err?.name !== 'AbortError') throw err;
  }).finally(() => clearTimeout(timer));

  await waitForSpoolStart();

  const healthDuringHang = await fetch(`${base}/status`);
  const healthJson = await healthDuringHang.json();
  const aliveDuringHang = server.exitCode === null;

  await printPromise;

  console.log(`PRINTSERVICE_SPOOL_STARTED=true`);
  console.log(`PRINTSERVICE_STATUS_DURING_HANG=${healthDuringHang.status}`);
  console.log(`PRINTSERVICE_CONNECTED_DURING_HANG=${healthJson.connected === true}`);
  console.log(`PRINTSERVICE_PROCESS_ALIVE_DURING_HANG=${aliveDuringHang}`);
  console.log(`PRINTSERVICE_PRINT_REQUEST_SETTLED_WITHIN_${timeoutMs}MS=${requestSettled}`);
  console.log(`PRINTSERVICE_PRINT_RESPONSE_STATUS=${responseStatus ?? 'NONE'}`);
  console.log(`PRINTSERVICE_CLIENT_ABORTED_AT_DEADLINE=${abortedByDeadline}`);
  if (responseBody) console.log(`PRINTSERVICE_PRINT_RESPONSE_BODY=${responseBody}`);

  if (!aliveDuringHang || healthDuringHang.status !== 200 || healthJson.connected !== true) {
    throw new Error('PrintService itself became unhealthy while the spooler was hung');
  }

  if (!requestSettled && abortedByDeadline) {
    throw new Error(`Hung spooler left /print without a bounded response for at least ${timeoutMs}ms`);
  }

  console.log('PRINTSERVICE_HUNG_SPOOLER_RUNTIME_PASS=true');
} finally {
  try { process.kill(-server.pid, 'SIGTERM'); } catch {}
  await sleep(200);
}
