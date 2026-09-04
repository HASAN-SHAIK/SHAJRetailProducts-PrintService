import { spawn } from 'node:child_process';
import http from 'node:http';

const port = 43133;
const env = { ...process.env, PORT: String(port), SUMATRA_PATH: '/definitely/missing/SumatraPDF.exe' };
const child = spawn(process.execPath, ['server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
child.stdout.on('data', d => { logs += d.toString(); process.stdout.write(d); });
child.stderr.on('data', d => { logs += d.toString(); process.stderr.write(d); });

const request = (method, path, body, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ hostname: '127.0.0.1', port, method, path, headers }, res => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
  });
  req.on('error', reject);
  if (body !== undefined) req.write(body);
  req.end();
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

try {
  let ready = false;
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null) throw new Error(`PrintService exited during startup: ${child.exitCode}\n${logs}`);
    try {
      const r = await request('GET', '/status');
      if (r.status === 200) { ready = true; break; }
    } catch {}
    await sleep(100);
  }
  if (!ready) throw new Error(`PrintService did not become ready\n${logs}`);

  const malformed = await request('POST', '/print', '{"items":[}', {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength('{"items":[}')
  });
  console.log(`PRINTSERVICE_MALFORMED_JSON_STATUS=${malformed.status}`);
  if (malformed.status !== 400) throw new Error(`Expected malformed JSON to return 400, got ${malformed.status}: ${malformed.body}`);

  if (child.exitCode !== null) throw new Error(`PrintService died after malformed JSON: ${child.exitCode}`);
  console.log('PRINTSERVICE_PROCESS_ALIVE_AFTER_MALFORMED_JSON=true');

  const health = await request('GET', '/status');
  console.log(`PRINTSERVICE_STATUS_AFTER_MALFORMED_JSON=${health.status}`);
  if (health.status !== 200) throw new Error(`Expected /status 200 after malformed JSON, got ${health.status}`);

  const validBody = JSON.stringify({ billNo: 'V1-MALFORMED-JSON', items: [] });
  const valid = await request('POST', '/print', validBody, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(validBody)
  });
  console.log(`PRINTSERVICE_VALID_PRINT_AFTER_MALFORMED_JSON_STATUS=${valid.status}`);
  if (valid.status !== 500 || !valid.body.includes('SumatraPDF not found')) {
    throw new Error(`Expected valid /print to reach print handler and fail only at virtual Sumatra boundary, got ${valid.status}: ${valid.body}`);
  }

  console.log('PRINTSERVICE_MALFORMED_JSON_RUNTIME_PASS=true');
} finally {
  child.kill('SIGTERM');
  await Promise.race([new Promise(r => child.once('exit', r)), sleep(1000)]);
}
