/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS test server. */
// Every browser run owns its database and server; never reuse the developer's server.
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
const dir = mkdtempSync(join(tmpdir(), 'ai-flow-browser-'));
const fixtureEnv = { ...process.env, DATABASE_PATH: join(dir, 'canvas.db'), NEXT_TEST_DIST: '.next-canvas-test', AGENT_CONFIG_PATH: join(process.cwd(), 'tests/fixtures/agent-browser-config.json'), AGENT_BROWSER_FIXTURE_KEY: 'not-a-provider-key', GEMINI_API_KEY: 'browser-fixture-no-real-provider' };
const agent = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/agent-browser-worker.ts'], { stdio: 'inherit', env: fixtureEnv });
const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', '3217'], {
  stdio: 'inherit', env: fixtureEnv,
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { agent.kill(signal); child.kill(signal); });
child.on('exit', code => { agent.kill('SIGTERM'); rmSync(dir, { recursive: true, force: true }); process.exit(code || 0); });
