require('@next/env').loadEnvConfig(process.cwd());
require('./register-typescript.cjs');
const { getGenerationService } = require('../lib/generation/server.ts');
const { GenerationWorker } = require('../lib/generation/worker.ts');
const { saveGenerationImage } = require('../lib/generation/storage.ts');
const { createRunningHubTransport } = require('../lib/generation/transport.ts');
const { closeDatabase } = require('../lib/db/index.ts');
const { runGenerationWorker } = require('../lib/generation/runner.ts');
const stopping = new AbortController();
process.on('SIGINT', () => stopping.abort());
process.on('SIGTERM', () => stopping.abort());
async function main() {
  const service = getGenerationService();
  const transport = createRunningHubTransport();
  const worker = new GenerationWorker(service, { fetch: transport.fetch, save: saveGenerationImage });
  try {
    console.log('[generation] worker started');
    await runGenerationWorker(worker, {
      // Extra lane allows query/save work alongside synchronous providers. Claims still enforce limits.
      parallelism: service.config.connections.reduce((sum, connection) => sum + connection.concurrency, 1),
      signal: stopping.signal,
      onError: () => console.error('[generation] worker iteration failed; inspect private task diagnostics'),
    });
  } finally {
    worker.close();
    await transport.close();
    closeDatabase();
  }
}
main().catch(() => { console.error('[generation] startup failed'); process.exitCode = 1; });
