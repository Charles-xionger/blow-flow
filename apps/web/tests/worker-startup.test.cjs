const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

test('standalone generation worker starts and shuts down with an empty database', { timeout: 10000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'worker-startup-'));
  const child = spawn(process.execPath, ['scripts/generation-worker.cjs'], {
    env: { ...process.env, DATABASE_PATH: path.join(dir, 'test.db') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let started = false;
  let stderr = '';
  child.stdout.on('data', chunk => {
    if (chunk.toString().includes('[generation] worker started')) {
      started = true;
      child.kill('SIGTERM');
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', resolve);
    });
    assert.ok(started, `Worker never started: ${stderr}`);
    assert.equal(code, 0);
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
