/* eslint-disable @typescript-eslint/no-require-imports -- Node and Playwright load these entry points as CommonJS. */
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

const sourcePaths = ['app', 'components', 'config', 'hooks', 'lib', 'migrations', 'public',
  'scripts', 'services', 'store', 'tests', 'types', 'package.json', 'pnpm-lock.yaml',
  'pnpm-workspace.yaml', 'tsconfig.json', 'next.config.ts', 'playwright.config.ts',
  'postcss.config.mjs', 'eslint.config.mjs', 'components.json', '.npmrc'];

function sources(root) {
  // Include untracked source files; generated output and runtime databases are
  // outside these paths. A dirty working tree is valid if it stays unchanged.
  const names = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...sourcePaths],
    { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).split('\0').filter(Boolean);
  // Environment files are normally gitignored, but can still change app behavior.
  names.push(...readdirSync(root).filter(name => /^\.env(?:\.|$)/.test(name)));
  return new Map([...new Set(names)].sort().map(name => {
    try { return [name, createHash('sha256').update(readFileSync(join(root, name))).digest('hex')]; }
    catch (error) { if (error.code === 'ENOENT') return [name, null]; throw error; }
  }));
}

/** Playwright's final status is failed when results span different source states. */
class SourceGuardReporter {
  constructor(options = {}) {
    this.root = options.root || process.cwd();
    this.baseline = sources(this.root);
    this.changed = new Set();
    this.error = undefined;
  }

  check() {
    try {
      const current = sources(this.root);
      for (const name of new Set([...this.baseline.keys(), ...current.keys()])) {
        if (this.baseline.get(name) !== current.get(name)) this.changed.add(name);
      }
    } catch (error) { this.error = error.message; }
  }

  onBegin() { this.check(); }
  onTestEnd() { this.check(); }
  onEnd() {
    this.check();
    if (!this.changed.size && !this.error) return;
    console.error('\n[source-guard] 本轮浏览器测试结果无效：源码在运行期间发生变化，或无法完成校验。');
    for (const name of [...this.changed].sort()) console.error(`  ${name}`);
    if (this.error) console.error(`  ${this.error}`);
    console.error('[source-guard] 完成修改后重新运行受影响的测试；本轮不能报告为通过。');
    return { status: 'failed' };
  }
  printsToStdio() { return false; }
}
module.exports = SourceGuardReporter;
