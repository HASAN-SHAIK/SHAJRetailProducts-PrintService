import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';

const port = 43135;
const base = `http://127.0.0.1:${port}`;
const marker = '/tmp/shaj-printer-discovery-started';
const fakeDir = '/tmp/shaj-fake-powershell-bin';
const fakePowerShell = resolve('tests/fake-powershell-discovery-hang.sh');
const link = `${fakeDir}/powershell`;

rmSync(marker, { force: true });
rmSync(fakeDir, { recursive: true, force: true });
mkdirSync(fakeDir, { recursive: true });
symlinkSync(fakePowerShell, link);

const server = spawn(process.execPath, ['server.js'], {
  env: {
    ...process.env,
    PORT: String(port),
    PATH: `${fakeDir}:${process.env.PATH || ''}`,
    DISCOVERY_MARKER: marker,
  },
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
server.stdout.on('data', (chunk) => { stdout += String(chunk); process.stdout.write(chunk); });
server.stderr.on('data', (chunk) => { stderr += String(chunk); process.stderr.write(chunk); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForStatus() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`${base}/status`);
      if (res.status === 200) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`PrintService did not become ready. stdout=${stdout} stderr=${stderr}`);
}

function cleanup() {
  try { process.kill(-server.pid, 'SIGTERM'); } catch {}
  rmSync(marker, { force: true });
  rmSync(fakeDir, { recursive: true, force: true });
}

try {
  await waitForStatus();

  const controller = new AbortController();
  let settled = false;
  let responseStatus = 'NONE';
  let requestError = null;

  const printerRequest = fetch(`${base}/printers`, { signal: controller.signal })
    .then(async (res) => {
      settled = true;
      responseStatus = String(res.status);
      await res.text();
    })
    .catch((err) => {
      requestError = err;
    });

  for (let i = 0; i < 30 && !existsSync(marker); i += 1) await sleep(50);
  const discoveryStarted = existsSync(marker);

  await sleep(2500);
  const settledWithinDeadline = settled;

  const statusRes = await fetch(`${base}/status`);
  const statusBody = await statusRes.json();
  let processAlive = true;
  try { process.kill(server.pid, 0); } catch { processAlive = false; }

  if (!settledWithinDeadline) controller.abort();
  await printerRequest;

  console.log(`PRINTSERVICE_DISCOVERY_STARTED=${discoveryStarted}`);
  console.log(`PRINTSERVICE_PRINTERS_REQUEST_SETTLED_WITHIN_2500MS=${settledWithinDeadline}`);
  console.log(`PRINTSERVICE_PRINTERS_RESPONSE_STATUS=${responseStatus}`);
  console.log(`PRINTSERVICE_STATUS_DURING_HANG=${statusRes.status}`);
  console.log(`PRINTSERVICE_CONNECTED_DURING_HANG=${statusBody.connected === true}`);
  console.log(`PRINTSERVICE_PROCESS_ALIVE_DURING_HANG=${processAlive}`);
  console.log(`PRINTSERVICE_CLIENT_ABORTED_AT_DEADLINE=${!settledWithinDeadline && requestError?.name === 'AbortError'}`);

  if (!discoveryStarted) throw new Error('virtual PowerShell discovery process never started');
  if (!processAlive || statusRes.status !== 200 || statusBody.connected !== true) {
    throw new Error('PrintService did not remain healthy while discovery was hung');
  }
  if (!settledWithinDeadline) {
    throw new Error('printer discovery request remained pending beyond 2500ms');
  }

  console.log('PRINTER_DISCOVERY_TIMEOUT_RUNTIME_PASS=true');
} finally {
  cleanup();
}
