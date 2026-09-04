import fs from 'node:fs';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

assert.match(
  source,
  /bodyParser\.json\(\{\s*limit:\s*["']1mb["']\s*\}\)/,
  'PrintService must keep the explicit 1 MiB JSON request limit',
);
assert.match(source, /app\.post\(["']\/print["']/, 'PrintService must expose the /print route');
assert.match(source, /app\.get\(["']\/status["']/, 'PrintService must expose /status for post-rejection liveness verification');

console.log('PRINTSERVICE_BODY_LIMIT_ACCEPTANCE_PASS=true');
