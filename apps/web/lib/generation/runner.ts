import { setTimeout as delay } from 'node:timers/promises';
import type { GenerationWorker } from './worker';

/** Each lane drains work; the database enforces per-connection limits across all processes. */
export async function runGenerationWorker(worker: GenerationWorker, options: {
  parallelism: number; signal: AbortSignal; onError: (error: unknown) => void; idleMs?: number;
}) {
  if (!Number.isSafeInteger(options.parallelism) || options.parallelism < 1) throw new Error('Invalid worker parallelism');
  await Promise.all(Array.from({ length: options.parallelism }, async () => {
    while (!options.signal.aborted) {
      try { if (await worker.tick()) continue; }
      catch (error) { options.onError(error); }
      try { await delay(options.idleMs ?? 1000, undefined, { signal: options.signal }); }
      catch { if (!options.signal.aborted) throw new Error('Worker delay failed'); }
    }
  }));
}
