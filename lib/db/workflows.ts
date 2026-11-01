import { getDatabase } from "./index";
import type { Node, Edge, Viewport } from "@xyflow/react";
import { createHash } from "node:crypto";
import { projectCover } from "../workspace/cover";
import { canonicalJSON, CanvasSaveError, validateSaveOperation, type SaveOperation, type SaveAcknowledgement } from "../canvas/save-protocol";

export interface WorkflowData {
  id: string;
  name: string;
  nodes: Node[];
  edges: Edge[];
  viewport: Viewport;
  createdAt: number;
  updatedAt: number;
  version: number;
}

interface WorkflowRow {
  id: string;
  name: string;
  data: string;
  created_at: number;
  updated_at: number;
  version: number;
}

export function getAllWorkflows(): WorkflowData[] {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT * FROM workflows WHERE deleted_at IS NULL
    ORDER BY updated_at DESC
  `);

  const rows = stmt.all() as WorkflowRow[];

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    ...JSON.parse(row.data),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  }));
}

export function getWorkflowById(id: string): WorkflowData | null {
  const db = getDatabase();
  const stmt = db.prepare("SELECT * FROM workflows WHERE id = ? AND deleted_at IS NULL");
  const row = stmt.get(id) as WorkflowRow | undefined;

  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    ...JSON.parse(row.data),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

/** The only content writer: content, version and receipt commit atomically. */
export function saveWorkflow(operation: SaveOperation): SaveAcknowledgement {
  validateSaveOperation(operation);
  const { id, requestId, baseVersion, snapshot } = operation;
  const digest = createHash("sha256").update(canonicalJSON({ baseVersion, snapshot })).digest("hex");
  const db = getDatabase();
  return db.transaction(() => {
    // Deletion dominates historical receipts: a replay must never report a
    // tombstoned canvas as a currently saved project.
    if (isWorkflowDeleted(id)) throw new CanvasSaveError("画布已被删除，本地内容已保留，请另存副本", 410);
    const receipt = db.prepare("SELECT digest, version FROM canvas_save_receipts WHERE canvas_id = ? AND request_id = ?")
      .get(id, requestId) as { digest: string; version: number } | undefined;
    if (receipt) {
      if (receipt.digest !== digest) throw new CanvasSaveError("Request ID already used with different content", 409);
      return { id, requestId, version: receipt.version };
    }
    const existing = db.prepare("SELECT version, data, cover_url FROM workflows WHERE id = ?").get(id) as { version: number; data: string; cover_url: string | null } | undefined;
    if ((existing?.version ?? 0) !== baseVersion) throw new CanvasSaveError("Canvas version conflict; local content has been preserved", 409);
    const version = baseVersion + 1;
    const now = Date.now();
    const data = JSON.stringify({ nodes: snapshot.nodes, edges: snapshot.edges, viewport: snapshot.viewport });
    const cover = projectCover(snapshot.nodes, existing ? JSON.parse(existing.data).nodes : [], existing?.cover_url);
    db.prepare(`INSERT INTO workflows (id, name, data, created_at, updated_at, version, cover_url, node_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, data = excluded.data,
        updated_at = excluded.updated_at, version = excluded.version, cover_url = excluded.cover_url, node_count = excluded.node_count`)
      .run(id, snapshot.name, data, now, now, version, cover, snapshot.nodes.length);
    db.prepare("INSERT INTO canvas_save_receipts (canvas_id, request_id, digest, version) VALUES (?, ?, ?, ?)")
      .run(id, requestId, digest, version);
    return { id, requestId, version };
  }).immediate();
}

export function isWorkflowDeleted(id: string): boolean {
  return !!getDatabase().prepare("SELECT 1 FROM workflows WHERE id = ? AND deleted_at IS NOT NULL").get(id);
}

export function deleteWorkflow(id: string): boolean {
  const db = getDatabase();
  return db.transaction(() => {
    const result = db.prepare("UPDATE workflows SET deleted_at = ?, version = version + 1 WHERE id = ? AND deleted_at IS NULL")
      .run(Date.now(), id);
    return result.changes > 0 || isWorkflowDeleted(id);
  }).immediate();
}
