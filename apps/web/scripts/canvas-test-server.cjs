/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS test server. */
// Every browser run owns its database and server; never reuse the developer's server.
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
const dir = mkdtempSync(join(tmpdir(), 'ai-flow-browser-'));
const fixtureEnv = { ...process.env, DATABASE_PATH: join(dir, 'canvas.db'), NEXT_TEST_DIST: '.next-canvas-test', AGENT_CONFIG_PATH: join(process.cwd(), 'tests/fixtures/agent-browser-config.json'), AGENT_BROWSER_FIXTURE_KEY: 'not-a-provider-key', GEMINI_API_KEY: 'browser-fixture-no-real-provider', ARK_API_KEY: 'browser-fixture-no-real-provider', SENTRY_DSN: '', NEXT_PUBLIC_SENTRY_DSN: '', OSS_BUCKET_NAME: 'browser-fixture', OSS_REGION: 'oss-test' };
const startAgent = () => spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/agent-browser-worker.ts'], { stdio: 'inherit', env: fixtureEnv });
let agent = startAgent();
const scriptWorker = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/script-browser-worker.ts'], { stdio: 'inherit', env: fixtureEnv });
// Test-only process control; no application endpoint or provider access.
const control = require('node:http').createServer((request,response) => {
  if (request.method !== 'POST' || request.url !== '/restart-agent') { response.writeHead(404).end(); return; }
  agent.once('exit', () => { agent = startAgent(); response.writeHead(200).end('restarted'); });
  agent.kill('SIGKILL');
});
control.listen(3218, '127.0.0.1');
const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', '3217'], {
  stdio: 'inherit', env: fixtureEnv,
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { control.close(); agent.kill(signal); scriptWorker.kill(signal); child.kill(signal); });
child.on('exit', code => { control.close(); agent.kill('SIGTERM'); scriptWorker.kill('SIGTERM'); rmSync(dir, { recursive: true, force: true }); process.exit(code || 0); });
