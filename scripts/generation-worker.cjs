require('@next/env').loadEnvConfig(process.cwd());
require('./register-typescript.cjs');
const { getGenerationService } = require('../lib/generation/server.ts');
const { GenerationWorker } = require('../lib/generation/worker.ts');
const { saveGenerationImage } = require('../lib/generation/storage.ts');
const { closeDatabase } = require('../lib/db/index.ts');
const { setTimeout: delay } = require('node:timers/promises');
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });
async function main() {
  const service = getGenerationService();
  const worker = new GenerationWorker(service, { fetch, save: saveGenerationImage });
  console.log('[generation] worker started');
  while (!stopping) {
    try { if (await worker.tick()) continue; }
    catch { console.error('[generation] worker iteration failed; inspect private task diagnostics'); }
    await delay(1000);
  }
  closeDatabase();
}
main().catch(() => { console.error('[generation] startup failed'); process.exitCode = 1; });
