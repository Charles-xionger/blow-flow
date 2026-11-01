// Every browser run owns its database and server; never reuse the developer's server.
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
const dir = mkdtempSync(join(tmpdir(), 'ai-flow-browser-'));
const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', '3217'], {
  stdio: 'inherit', env: { ...process.env, DATABASE_PATH: join(dir, 'canvas.db'), NEXT_TEST_DIST: '.next-canvas-test' },
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', code => { rmSync(dir, { recursive: true, force: true }); process.exit(code || 0); });
