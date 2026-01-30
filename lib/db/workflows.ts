import { getDatabase } from "./index";
import type { Node, Edge, Viewport } from "@xyflow/react";
import { nanoid } from "nanoid";

export interface WorkflowData {
  id: string;
  name: string;
  nodes: Node[];
  edges: Edge[];
  viewport: Viewport;
  createdAt: number;
  updatedAt: number;
}

interface WorkflowRow {
  id: string;
  name: string;
  data: string;
  created_at: number;
  updated_at: number;
}

export function getAllWorkflows(): WorkflowData[] {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT * FROM workflows 
    ORDER BY updated_at DESC
  `);

  const rows = stmt.all() as WorkflowRow[];

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    ...JSON.parse(row.data),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function getWorkflowById(id: string): WorkflowData | null {
  const db = getDatabase();
  const stmt = db.prepare("SELECT * FROM workflows WHERE id = ?");
  const row = stmt.get(id) as WorkflowRow | undefined;

  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    ...JSON.parse(row.data),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createWorkflow(
  workflow: Omit<WorkflowData, "id" | "createdAt" | "updatedAt">,
): WorkflowData {
  const db = getDatabase();
  const id = nanoid();
  const now = Date.now();

  const data = JSON.stringify({
    nodes: workflow.nodes || [],
    edges: workflow.edges || [],
    viewport: workflow.viewport || { x: 0, y: 0, zoom: 1 },
  });

  const stmt = db.prepare(`
    INSERT INTO workflows (id, name, data, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  stmt.run(id, workflow.name, data, now, now);

  return {
    id,
    name: workflow.name,
    nodes: workflow.nodes || [],
    edges: workflow.edges || [],
    viewport: workflow.viewport || { x: 0, y: 0, zoom: 1 },
    createdAt: now,
    updatedAt: now,
  };
}

export function updateWorkflow(
  id: string,
  workflow: Partial<WorkflowData>,
): boolean {
  const db = getDatabase();
  const now = Date.now();

  const updates: string[] = [];
  const params: unknown[] = [];

  if (workflow.name !== undefined) {
    updates.push("name = ?");
    params.push(workflow.name);
  }

  if (workflow.nodes || workflow.edges || workflow.viewport) {
    const existing = getWorkflowById(id);
    if (!existing) return false;

    const data = JSON.stringify({
      nodes: workflow.nodes || existing.nodes,
      edges: workflow.edges || existing.edges,
      viewport: workflow.viewport || existing.viewport,
    });

    updates.push("data = ?");
    params.push(data);
  }

  if (updates.length === 0) return false;

  updates.push("updated_at = ?");
  params.push(now);

  params.push(id);

  const stmt = db.prepare(`
    UPDATE workflows 
    SET ${updates.join(", ")}
    WHERE id = ?
  `);

  const result = stmt.run(...params);
  return result.changes > 0;
}

export function deleteWorkflow(id: string): boolean {
  const db = getDatabase();
  const stmt = db.prepare("DELETE FROM workflows WHERE id = ?");
  const result = stmt.run(id);
  return result.changes > 0;
}
