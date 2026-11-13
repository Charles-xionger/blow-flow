import type Database from 'better-sqlite3';
import { generationOwnerState } from '../agent/generation-lease';
import type { CreateGeneration } from './types';

type Binding = {id:string;version:number};
type Permission = {approved:number;owner_task_id:string;bindings:string;request_json:string};
/** Shared persisted approval boundary. Uses the supplied SQLite connection, including its active
 * transaction: approval + queue, output + binding advancement, and paid submission stay atomic. */
export class GenerationPermissions {
    constructor(private db: Database.Database) {
        db.exec(`CREATE TABLE IF NOT EXISTS generation_permissions (
            request_id TEXT PRIMARY KEY, owner_task_id TEXT NOT NULL, approved INTEGER NOT NULL DEFAULT 0,
            bindings TEXT NOT NULL, request_json TEXT NOT NULL)`);
    }
    prepare(ownerId: string, request: CreateGeneration, bindings: Binding[]) {
        this.db.prepare('INSERT INTO generation_permissions VALUES(?,?,0,?,?)').run(request.requestId, ownerId, JSON.stringify(bindings), JSON.stringify(request));
    }
    approve(requestId: string) { this.db.prepare('UPDATE generation_permissions SET approved=1 WHERE request_id=?').run(requestId); }
    revoke(requestId: string) { this.db.prepare('UPDATE generation_permissions SET approved=0 WHERE request_id=?').run(requestId); }
    advanceBinding(requestId: string, nodeId: string, before: number, after: number) {
        const permission = this.read(requestId);
        if (!permission) return;
        const bindings = JSON.parse(permission.bindings) as Binding[];
        for (const binding of bindings) if (binding.id === nodeId && binding.version === before) binding.version = after;
        this.db.prepare('UPDATE generation_permissions SET bindings=? WHERE request_id=?').run(JSON.stringify(bindings), requestId);
    }
    paused(requestId: string): boolean {
        const permission = this.read(requestId);
        return !!permission && generationOwnerState(this.db, permission.owner_task_id) === 'paused';
    }
    authorizes(requestId: string, requestJson: string): boolean {
        const permission = this.read(requestId);
        if (!permission) return true; // Manual requests retain their existing checks.
        if (!permission.approved || permission.request_json !== requestJson || generationOwnerState(this.db, permission.owner_task_id) !== 'active') return false;
        const request: CreateGeneration = JSON.parse(requestJson);
        const row = this.db.prepare('SELECT data FROM workflows WHERE id=? AND deleted_at IS NULL').get(request.canvasId) as {data:string}|undefined;
        if (!row) return false;
        const canvas = JSON.parse(row.data) as {nodes:{id:string;data:{generationContentVersion?:number}}[]};
        return (JSON.parse(permission.bindings) as Binding[]).every(binding => {
            const node = canvas.nodes.find(node => node.id === binding.id);
            return node && (node.data.generationContentVersion ?? 0) === binding.version;
        });
    }
    private read(requestId: string) { return this.db.prepare('SELECT * FROM generation_permissions WHERE request_id=?').get(requestId) as Permission|undefined; }
}
