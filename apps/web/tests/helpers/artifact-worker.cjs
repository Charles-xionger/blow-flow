require('../../scripts/register-typescript.cjs');
const Database = require('better-sqlite3');
const { GenerationService } = require('../../lib/generation/service.ts');
const { GenerationWorker } = require('../../lib/generation/worker.ts');
const { artifactHttpIO } = require('./artifact-http-io.cjs');
process.on('message', async ({ filename, config, base, now }) => {
  const service = new GenerationService(new Database(filename), config);
  const worker = new GenerationWorker(service, { ...artifactHttpIO(base), now: () => now });
  await worker.tick();
  await worker.tick();
  process.send('completed');
});
