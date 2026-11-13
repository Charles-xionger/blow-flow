import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('explicit publication sends experiment traces and scores through the real Langfuse SDK to a local collector', { timeout: 30_000 }, async () => {
  const received: Array<{ path: string; body: Buffer }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    received.push({ path: req.url || '', body });
    if (req.url?.includes('/otel/')) {
      res.writeHead(200, { 'content-type': 'application/x-protobuf' }).end();
    } else {
      const batch = req.url?.includes('/scores') ? JSON.parse(body.toString()) : [];
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        data: [{ id: 'fixture', name: 'fixture' }],
        accepted: batch.length, rejected: 0, errors: [],
      }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/run.ts', '--publish'], {
    env: { ...process.env, LANGFUSE_BASE_URL: 'http://127.0.0.1:' + address.port,
      LANGFUSE_PUBLIC_KEY: 'fixture-public', LANGFUSE_SECRET_KEY: 'fixture-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 25_000);
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, output);
    assert.ok(received.some(item => item.path.includes('/otel/') && item.body.length > 0), 'missing experiment traces');
    assert.ok(received.some(item => item.path.includes('/scores') && item.body.includes('contract-correctness')), 'missing evaluation scores');
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill('SIGKILL');
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
