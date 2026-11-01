require('../scripts/register-typescript.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const { once } = require('node:events');
const { networkInterfaces, tmpdir } = require('node:os');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { execFileSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const Database = require('better-sqlite3');
const { createRunningHubTransport } = require('../lib/generation/transport.ts');
const { GenerationService } = require('../lib/generation/service.ts');
const { GenerationWorker } = require('../lib/generation/worker.ts');
const { defaultConfig } = require('../lib/generation/config.ts');

async function listen(t, server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return server.address().port;
}
const loopback = Object.entries(networkInterfaces()).find(([, addresses]) => addresses.some(a => a.address === '127.0.0.1'))[0];

test('H3 uploads, creates once and queries through the configured IP while retaining the platform Host', async t => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, host: req.headers.host, body, authorization: req.headers.authorization, source: req.socket.remoteAddress });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ code: 0, data: req.url.endsWith('/upload') ? { fileName: 'api/reference.png' }
      : req.url.endsWith('/create') ? { taskId: '1234567890123456789' }
      : [{ nodeId: '148', fileType: 'mp4', fileUrl: 'https://results.test/movie.mp4' }] }));
  });
  const port = await listen(t, server);
  const origin = `http://runninghub.invalid:${port}`;
  const transport = createRunningHubTransport({ origin, connectIp: '127.0.0.1', localInterface: loopback });
  t.after(() => transport.close());
  const config = structuredClone(defaultConfig); config.connections[0].baseUrl = origin;
  process.env.RUNNINGHUB_API_KEY = 'test-transport-key';
  process.env.OSS_BUCKET_NAME = 'transport-test'; process.env.OSS_REGION = 'oss-cn-hangzhou';
  const db = new Database(':memory:'); t.after(() => db.close());
  const service = new GenerationService(db, config);
  const worker = new GenerationWorker(service, {
    fetch: (url, init) => url.startsWith('https://transport-test.') ? Promise.resolve(new Response('reference bytes')) : transport.fetch(url, init),
    inspectReference: async () => ({ hasAudio: false }),
    save: async () => 'https://saved.test/movie.mp4',
  });
  t.after(() => worker.close());
  const task = service.create({ requestId: 'routing', modelId: 'runninghub-h3', canvasId: 'canvas', nodeId: 'node',
    input: { prompt: 'video', width: 1280, height: 736, duration: 7,
      references: [{ kind: 'image', url: 'https://transport-test.oss-cn-hangzhou.aliyuncs.com/reference.png' }] } });
  await worker.tick(); await worker.tick();
  assert.equal(service.get(task.id).saveStatus, 'saved');
  assert.deepEqual(requests.map(r => r.path), ['/task/openapi/upload', '/task/openapi/create', '/task/openapi/outputs']);
  for (const req of requests) {
    assert.equal(req.host, `runninghub.invalid:${port}`);
    assert.equal(req.authorization, 'Bearer test-transport-key');
    assert.equal(req.source, '127.0.0.1');
  }
  assert.match(requests[0].body, /filename="reference.png"/);
  assert.match(requests[0].body, /reference bytes/);
});

test('unconfigured transport and unrelated origins retain ordinary fetch routing', async t => {
  assert.equal(createRunningHubTransport({}).fetch, globalThis.fetch);
  const port = await listen(t, http.createServer((req, res) => res.end(req.headers.host)));
  const transport = createRunningHubTransport({ origin: `http://other.invalid:${port}`, connectIp: '192.0.2.1' });
  t.after(() => transport.close());
  const response = await transport.fetch(new Request(`http://127.0.0.1:${port}/asset`));
  assert.equal(await response.text(), `127.0.0.1:${port}`);
});

test('a lost paid response is never replayed and redirects cannot move platform credentials', async t => {
  let calls = 0;
  const port = await listen(t, http.createServer((req, res) => {
    calls++;
    req.resume();
    if (req.url === '/create') req.on('end', () => req.socket.destroy());
    else { res.writeHead(307, { Location: '/unexpected' }); res.end(); }
  }));
  const origin = `http://runninghub.invalid:${port}`;
  const transport = createRunningHubTransport({ origin, connectIp: '127.0.0.1' }); t.after(() => transport.close());
  await assert.rejects(transport.fetch(origin + '/create', { method: 'POST', body: '{"apiKey":"test"}' }));
  assert.equal(calls, 1);
  await assert.rejects(transport.fetch(origin + '/redirect', { method: 'POST', body: 'test', redirect: 'follow' }));
  assert.equal(calls, 2);
});

test('invalid IPs and missing interfaces fail before any platform request', () => {
  assert.throws(() => createRunningHubTransport({ connectIp: 'https://43.168.19.45' }), /IPv4 or IPv6/);
  assert.throws(() => createRunningHubTransport({ connectIp: '127.0.0.1', localInterface: 'missing-test-interface' }), /no address/);
  assert.throws(() => createRunningHubTransport({ localInterface: loopback }), /requires/);
  assert.throws(() => createRunningHubTransport({ origin: 'https://127.0.0.1', connectIp: '127.0.0.1' }), /hostname/);
});

test('pinned HTTPS retains SNI and certificate hostname verification', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'generation-tls-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=runninghub.test'], { stdio: 'ignore' });
  let servername, host;
  const server = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    servername = req.socket.servername; host = req.headers.host; res.end('verified');
  });
  const port = await listen(t, server);
  // Trust only this test CA in a child; production TLS validation is never relaxed.
  const code = `require('./scripts/register-typescript.cjs');
    const assert = require('node:assert/strict');
    const { createRunningHubTransport } = require('./lib/generation/transport.ts');
    (async () => {
      for (const name of ['runninghub.test', 'wrong.test']) {
        const origin = 'https://' + name + ':${port}';
        const transport = createRunningHubTransport({ origin, connectIp: '127.0.0.1' });
        try {
          if (name === 'wrong.test') await assert.rejects(transport.fetch(origin), e => e.cause?.code === 'ERR_TLS_CERT_ALTNAME_INVALID');
          else assert.equal(await (await transport.fetch(origin)).text(), 'verified');
        } finally { await transport.close(); }
      }
    })().catch(e => { console.error(e); process.exitCode = 1; });`;
  await promisify(execFile)(process.execPath, ['-e', code], { env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, timeout: 15000 });
  assert.equal(servername, 'runninghub.test'); assert.equal(host, `runninghub.test:${port}`);
});
