require('../../scripts/register-typescript.cjs');
const Database = require('better-sqlite3');
const { GenerationService } = require('../../lib/generation/service.ts');
const { GenerationWorker } = require('../../lib/generation/worker.ts');
process.on('message', async ({ filename, config, phase, now }) => {
  const service = new GenerationService(new Database(filename), config);
  const worker = new GenerationWorker(service, { now: () => now,
    fetch: async url => {
      if (url.endsWith('/create')) {
        if (phase === 'submitting') {
          process.send('submitted');
          return new Promise(() => {});
        }
        return Response.json({ code: 0, data: { taskId: '987654321' } });
      }
      return Response.json({ code: 0, data: [{ nodeId: '103', fileUrl: 'https://test/image.png' }] });
    },
    save: async () => { process.send('saving'); return new Promise(() => {}); },
  });
  if (phase === 'queued') process.send('queued');
  else {
    await worker.tick();
    if (phase === 'saving') await worker.tick();
    else process.send('running');
  }
});
