import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const repo = process.cwd();
const port = 43137;
const marker = 'CYCLE-D-SENSITIVE-BILL-84721';
const tempReceipt = path.join(repo, 'temp.txt');
const work = await mkdir(path.join(os.tmpdir(), `printservice-cleanup-${process.pid}`), { recursive: true }).then(() => path.join(os.tmpdir(), `printservice-cleanup-${process.pid}`));
const bin = path.join(work, 'bin');
const spool = path.join(work, 'spooled.txt');
await mkdir(bin, { recursive: true });
await rm(tempReceipt, { force: true });

const powershell = path.join(bin, 'powershell');
const sumatra = path.join(bin, 'fake-sumatra.sh');
await writeFile(powershell, '#!/usr/bin/env bash\nprintf "%s\\n" "POSPrinter POS58"\n', 'utf8');
await writeFile(sumatra, `#!/usr/bin/env bash\nset -euo pipefail\nlast="\\${!#}"\ncp "$last" "${spool}"\n`, 'utf8');
await chmod(powershell, 0o755);
await chmod(sumatra, 0o755);

const child = spawn(process.execPath, ['server.js'], {
  cwd: repo,
  env: {
    ...process.env,
    PORT: String(port),
    PRINTER_NAME: 'POSPrinter POS58',
    SUMATRA_PATH: sumatra,
    PATH: `${bin}:${process.env.PATH}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', d => { logs += d.toString(); process.stdout.write(d); });
child.stderr.on('data', d => { logs += d.toString(); process.stderr.write(d); });

async function waitForStatus() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/status`);
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('PrintService did not become ready');
}

let exitCode = 1;
try {
  await waitForStatus();
  const response = await fetch(`http://127.0.0.1:${port}/print`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      shopName: 'Cycle D Store',
      billNo: marker,
      payment: 'cash',
      items: [{ name: 'Private Item', qty: 1, rate: 99 }],
      subtotal: 99,
      gst: 0,
      discount: 0,
      total: 99,
    }),
  });
  const body = await response.text();
  console.log(`PRINTSERVICE_PRINT_STATUS=${response.status}`);
  console.log(`PRINTSERVICE_PRINT_BODY=${body}`);
  if (response.status !== 200 || !body.includes('success')) throw new Error('real /print did not succeed');

  const spoolText = await readFile(spool, 'utf8');
  const spooledMarker = spoolText.includes(marker);
  const tempExistsAfter = existsSync(tempReceipt);
  const tempText = tempExistsAfter ? await readFile(tempReceipt, 'utf8') : '';
  const sensitiveResidual = tempText.includes(marker);

  const health = await fetch(`http://127.0.0.1:${port}/status`);
  const healthBody = await health.json();
  console.log(`PRINTSERVICE_SPOOL_CONTAINS_MARKER=${spooledMarker}`);
  console.log(`PRINTSERVICE_TEMP_EXISTS_AFTER_SUCCESS=${tempExistsAfter}`);
  console.log(`PRINTSERVICE_TEMP_CONTAINS_MARKER_AFTER_SUCCESS=${sensitiveResidual}`);
  console.log(`PRINTSERVICE_STATUS_AFTER=${health.status}`);
  console.log(`PRINTSERVICE_CONNECTED_AFTER=${healthBody.connected === true}`);
  console.log(`PRINTSERVICE_PROCESS_ALIVE_AFTER=${child.exitCode === null}`);
  console.log(`PRINTSERVICE_RECEIPT_CLEANUP_RUNTIME_PASS=${spooledMarker && !tempExistsAfter && !sensitiveResidual}`);

  if (!spooledMarker) throw new Error('virtual spool did not receive the real generated receipt');
  if (tempExistsAfter || sensitiveResidual) {
    throw new Error('successful print left plaintext receipt data in repository temp.txt');
  }
  exitCode = 0;
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
  await rm(work, { recursive: true, force: true });
  process.exitCode = exitCode;
}
