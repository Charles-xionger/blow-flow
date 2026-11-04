import type Database from 'better-sqlite3';
import type { AgentTask } from './types';

/** Read on the caller's transaction/connection so stop and lease expiry fence paid work atomically. */
export function generationOwnerState(db: Database.Database, taskId: string): 'active' | 'paused' | 'revoked' {
    const row = db.prepare('SELECT data FROM agent_tasks WHERE id=?').get(taskId) as {data:string}|undefined;
    if (!row) return 'revoked';
    const task = JSON.parse(row.data) as AgentTask;
    if (['stopped', 'failed'].includes(task.status)) return 'revoked';
    if (task.status === 'interrupted') return 'paused';
    if (task.workerId && task.status !== 'completed') {
        const lease = db.prepare('SELECT lease_until FROM agent_workers WHERE id=?').get(task.workerId) as {lease_until:number}|undefined;
        if (!lease || lease.lease_until <= Date.now()) return 'paused';
    }
    return 'active';
}
