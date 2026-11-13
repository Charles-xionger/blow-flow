import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());
import { getAgentService } from '../lib/agent/server';
import { createPiRuntime } from '../lib/agent/runtime';
import { langfuseTracerFromEnv } from '../lib/agent/tracing';
import { closeDatabase } from '../lib/db';
const service = getAgentService();
const tracer = langfuseTracerFromEnv();
const runtime = createPiRuntime(service, { tracer });
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });
async function main() {
    const running = new Set<Promise<void>>();
    console.log('[agent] background worker started');
    console.log(tracer ? `[agent] Langfuse tracing → ${process.env.LANGFUSE_BASE_URL}` : '[agent] Langfuse tracing off (set LANGFUSE_BASE_URL/PUBLIC_KEY/SECRET_KEY)');
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
        await tracer?.shutdown();
        closeDatabase();
    }
}
main().catch(() => { console.error('[agent] startup failed'); process.exitCode = 1; });
