import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

test('built Gin process serves health, dependency failures, request IDs and shuts down cleanly', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-flow-api-e2e-'));
  let child;
  try {
    const binary = join(dir, 'api');
    execFileSync('go', ['build', '-o', binary, './cmd/server'], { timeout: 90_000 });
    child = spawn(binary, [], { env: { ...process.env, API_ADDR: '127.0.0.1:0', DATABASE_URL: '', SENTRY_DSN: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    const address = await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(Error('API startup timed out')), 10_000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', () => { clearTimeout(timeout); reject(Error('API exited before readiness')); });
      child.stderr.on('data', chunk => {
        output += chunk.toString();
        const match = output.match(/address=(127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
    });
    const live = await fetch('http://' + address + '/health/live');
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: 'ok' });
    assert.match(live.headers.get('x-request-id'), /^[a-f0-9]{32}$/);
    const ready = await fetch('http://' + address + '/health/ready');
    assert.equal(ready.status, 503);
    assert.deepEqual(await ready.json(), { status: 'not_ready', components: { postgres: 'unavailable', rabbitmq: 'unavailable', redis: 'unavailable' } });
    assert.equal((await fetch('http://' + address + '/unknown')).status, 404);
    child.kill('SIGTERM');
    const [code, signal] = await exited;
    assert.equal(code, 0);
    assert.equal(signal, null);
  } finally {
    if (child && child.exitCode === null) {
      const killed = once(child, 'exit');
      child.kill('SIGKILL');
      await killed;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
