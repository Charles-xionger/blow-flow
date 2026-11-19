const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadEnvironment } = require('./with-env.cjs');

test('Go launcher loads repository model keys, app overrides, then shell overrides', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'go-env-'));
  const app = path.join(root, 'apps', 'api');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(root, '.env.local'), 'GEMINI_API_KEY=repo-gemini\nDATABASE_URL=repo-db\n');
  fs.writeFileSync(path.join(app, '.env.local'), 'GEMINI_API_KEY=app-gemini\nARK_API_KEY=app-ark\n');
  try {
    const env = loadEnvironment(root, app, true, { GEMINI_API_KEY: 'shell-gemini' });
    assert.equal(env.GEMINI_API_KEY, 'shell-gemini');
    assert.equal(env.ARK_API_KEY, 'app-ark');
    assert.equal(env.DATABASE_URL, 'repo-db');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
