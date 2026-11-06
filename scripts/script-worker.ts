import { loadEnvConfig } from '@next/env';
import { getScriptService } from '../lib/script/service';
import { closeDatabase } from '../lib/db';
loadEnvConfig(process.cwd());
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });
async function main() {
  const service = getScriptService();
  const jobs = new Set<Promise<unknown>>();
  console.log('[script] background worker started');
  while (!stopping) {
    if (jobs.size < 20) {
      const job = service.runNext().catch(() => console.error('[script] worker iteration failed')).finally(() => jobs.delete(job));
      jobs.add(job);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  await Promise.allSettled(jobs);
  closeDatabase();
}
void main().catch(() => { console.error('[script] startup failed'); process.exitCode = 1; });
