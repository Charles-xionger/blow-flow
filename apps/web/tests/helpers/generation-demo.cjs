// Optional browser smoke fixture: no real platform or OSS calls.
require('../../scripts/register-typescript.cjs');
const { createServer } = require('node:http');
const { GenerationWorker } = require('../../lib/generation/worker.ts');
const { getGenerationService } = require('../../lib/generation/server.ts');
const { spawn } = require('node:child_process');
const { mkdtempSync } = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
process.env.DATABASE_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'krea-demo-')), 'canvas.db');
process.env.RUNNINGHUB_BASE_URL = 'http://127.0.0.1:4319';
process.env.RUNNINGHUB_API_KEY = 'fake-browser-test-key';
let count = 0;
const server = createServer(async (req, res) => {
  for await (const chunk of req) { void chunk; }
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/task/openapi/create') { count++; console.log('Mock paid submit:', count); res.end(JSON.stringify({ code: 0, data: { taskId: String(count) } })); }
  else if (req.url === '/task/openapi/outputs') res.end(JSON.stringify({ code: 0, data: [{ nodeId: '103', fileUrl: 'http://127.0.0.1:4319/image.svg' }] }));
  else { res.setHeader('Content-Type', 'image/svg+xml'); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#174b38"/><circle cx="1400" cy="250" r="130" fill="#ffd870"/><path d="M0 900L600 200L1300 1080H0" fill="#408d63"/><text x="600" y="700" fill="white" font-size="90">Krea2 simulated result</text></svg>'); }
});
server.listen(4319, '127.0.0.1', () => {
  const worker = new GenerationWorker(getGenerationService(), { fetch, save: async () => 'http://127.0.0.1:4319/image.svg' });
  let busy = false;
  const timer = setInterval(async () => { if (busy) return; busy = true; try { await worker.tick(); } finally { busy = false; } }, 500);
  const next = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', '--port', '3101'], { env: process.env, stdio: 'inherit' });
  const stop = () => { clearInterval(timer); next.kill('SIGTERM'); server.close(); process.exit(); };
  next.on('exit', stop);
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
});
