import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());
import { getAgentService } from '../lib/agent/server';
import { createPiRuntime } from '../lib/agent/runtime';
import { closeDatabase } from '../lib/db';
const service = getAgentService();
const runtime = createPiRuntime(service);
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });
async function main() {
    const running = new Set<Promise<void>>();
    console.log('[agent] background worker started');
    try {
        while (!stopping) {
            if (running.size < 8) {
                const job = service.runNext(runtime).then(() => undefined).catch(() => { console.error('[agent] worker iteration failed'); }).finally(() => running.delete(job));
                running.add(job);
            }
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        await Promise.all(running);
    }
    finally {
        closeDatabase();
    }
}
main().catch(() => { console.error('[agent] startup failed'); process.exitCode = 1; });
