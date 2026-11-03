/* eslint-disable @typescript-eslint/no-require-imports -- Node and Playwright load these entry points as CommonJS. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const SourceGuard = require('../scripts/source-guard-reporter.cjs');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'source-guard-'));
  execFileSync('git', ['init', '--quiet', root]);
  mkdirSync(join(root, 'app'));
  writeFileSync(join(root, 'app/value.js'), 'original');
  writeFileSync(join(root, '.gitignore'), '.env*\n.next*/\ntest-results/\n');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('dirty sources and generated output are allowed while source edits remain invalid after a later revert', t => {
  const root = fixture(t);
  const reporter = new SourceGuard({ root });
  reporter.onBegin();
  mkdirSync(join(root, '.next-canvas-test'));
  writeFileSync(join(root, '.next-canvas-test/build.js'), 'generated');
  assert.equal(reporter.onEnd(), undefined);
  writeFileSync(join(root, 'app/value.js'), 'edited');
  reporter.onTestEnd();
  writeFileSync(join(root, 'app/value.js'), 'original');
  assert.deepEqual(reporter.onEnd(), { status: 'failed' });
});

test('added, deleted and ignored environment inputs invalidate a run', t => {
  for (const mutate of [
    root => writeFileSync(join(root, 'app/new.js'), 'new'),
    root => rmSync(join(root, 'app/value.js')),
    root => writeFileSync(join(root, '.env.local'), 'SECRET=changed'),
  ]) {
    const root = fixture(t);
    const reporter = new SourceGuard({ root });
    mutate(root);
    assert.deepEqual(reporter.onEnd(), { status: 'failed' });
  }
});

test('real Playwright exit status fails on source mutation, and passes for unchanged sources', t => {
  const root = fixture(t);
  mkdirSync(join(root, 'specs'));
  const config = join(root, 'playwright.config.cjs');
  writeFileSync(config, `module.exports = { testDir: './specs', workers: 1,
    reporter: [[${JSON.stringify(resolve(__dirname, '../scripts/source-guard-reporter.cjs'))}, { root: ${JSON.stringify(root)} }]] };`);
  const spec = join(root, 'specs/guard.spec.cjs');
  for (const changed of [false, true]) {
    writeFileSync(spec, `const { test } = require(${JSON.stringify(require.resolve('@playwright/test'))});
      test('fixture', () => { ${changed ? `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'app/value.js'))}, 'changed');` : ''} });`);
    const run = spawnSync(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '--config', config],
      { cwd: root, encoding: 'utf8', timeout: 30_000 });
    assert.equal(run.status, changed ? 1 : 0, run.stdout + run.stderr);
    if (changed) {
      assert.match(run.stderr, /source-guard/);
      assert.match(run.stderr, /app\/value.js/);
    }
  }
});
