import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shaj-print-command-boundary-'));
const binDir = path.join(workDir, 'bin');
const markerPath = path.join(workDir, 'unexpected-command-executed.txt');
const sumatraLog = path.join(workDir, 'sumatra-args.txt');
const port = 43136;
fs.mkdirSync(binDir, { recursive: true });

const printerName = `POS58\" ; printf injected > \"${markerPath}\" ; echo \"`;

const powershellPath = path.join(binDir, 'powershell');
fs.writeFileSync(
  powershellPath,
  '#!/usr/bin/env bash\nprintf "%s\\n" "$PRINTER_NAME"\n',
  { mode: 0o755 },
);

const sumatraPath = path.join(binDir, 'SumatraPDF');
fs.writeFileSync(
  sumatraPath,
  '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$SUMATRA_ARG_LOG"\nexit 0\n',
  { mode: 0o755 },
);

const env = {
  ...process.env,
  PORT: String(port),
  PRINTER_NAME: printerName,
  SUMATRA_PATH: sumatraPath,
  SUMATRA_ARG_LOG: sumatraLog,
  PATH: `${binDir}:${process.env.PATH || ''}`,
};

const child = spawn(process.execPath, ['server.js'], {
  cwd: repoRoot,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let logs = '';
child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
child.stderr.on('data', (chunk) => { logs += chunk.toString(); });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForStatus() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`);
      if (response.status === 200) return response;
    } catch {}
    await sleep(100);
  }
  throw new Error(`PrintService did not start. Logs:\n${logs}`);
}

let printStatus = null;
let printBody = '';
try {
  const statusResponse = await waitForStatus();
  const statusJson = await statusResponse.json();
  console.log(`PRINTSERVICE_STATUS_BEFORE=${statusResponse.status}`);
  console.log(`PRINTSERVICE_CONNECTED_BEFORE=${statusJson.connected === true}`);

  const response = await fetch(`http://127.0.0.1:${port}/print`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      shopName: 'SHAJ command-boundary probe',
      billNo: 'CMD-BOUNDARY-001',
      items: [{ name: 'Milk', qty: 1, rate: 10 }],
      subtotal: 10,
      gst: 0,
      discount: 0,
      total: 10,
    }),
  });
  printStatus = response.status;
  printBody = await response.text();

  await sleep(150);
  const markerExists = fs.existsSync(markerPath);
  const processAlive = child.exitCode === null;
  const followup = await fetch(`http://127.0.0.1:${port}/status`);

  console.log(`PRINTSERVICE_PRINT_STATUS=${printStatus}`);
  console.log(`PRINTSERVICE_PRINT_BODY=${printBody}`);
  console.log(`PRINTSERVICE_UNEXPECTED_COMMAND_EXECUTED=${markerExists}`);
  console.log(`PRINTSERVICE_PROCESS_ALIVE_AFTER=${processAlive}`);
  console.log(`PRINTSERVICE_STATUS_AFTER=${followup.status}`);
  console.log(`PRINTSERVICE_SUMATRA_CALLED=${fs.existsSync(sumatraLog)}`);

  if (markerExists) {
    throw new Error('Configured printer name escaped the intended Sumatra argument and executed an unintended shell command');
  }
  if (printStatus !== 200) {
    throw new Error(`Expected successful virtual print response, got ${printStatus}: ${printBody}`);
  }
  if (!processAlive || followup.status !== 200) {
    throw new Error('PrintService did not remain healthy after command-boundary probe');
  }

  console.log('PRINTSERVICE_PRINTER_NAME_COMMAND_BOUNDARY_RUNTIME_PASS=true');
} finally {
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(1000),
  ]);
  fs.rmSync(workDir, { recursive: true, force: true });
}
