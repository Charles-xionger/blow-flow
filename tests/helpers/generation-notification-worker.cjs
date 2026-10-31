require('../../scripts/register-typescript.cjs');
const Database = require('better-sqlite3');
const { GenerationService } = require('../../lib/generation/service.ts');
const { GenerationWorker } = require('../../lib/generation/worker.ts');
process.on('message', async ({ filename, config }) => {
  const db = new Database(filename);
  const worker = new GenerationWorker(new GenerationService(db, config), {
    fetch: async url => Response.json(url.endsWith('/create') ? { code: 0, data: { taskId: '123' } } :
      { code: 0, data: [{ nodeId: '103', fileUrl: 'https://platform.test/result.png' }] }),
    save: async () => 'https://oss.test/result.png',
  });
  try { await worker.tick(); await worker.tick(); }
  finally { worker.close(); db.close(); process.disconnect(); }
});
