import { getDatabase } from "./index";
import { saveWorkflow } from "./workflows";
import { CanvasSaveError } from "../canvas/save-protocol";
import type { ProjectFolder, ProjectSummary, WorkspaceData } from "../workspace/types";

export function getWorkspace(trash = false): WorkspaceData {
  const db = getDatabase();
  const projects = db.prepare(`SELECT id, name, folder_id AS folderId, cover_url AS coverUrl,
    node_count AS nodeCount, created_at AS createdAt, updated_at AS updatedAt,
    deleted_at AS deletedAt, version FROM workflows
    WHERE purged_at IS NULL AND deleted_at IS ${trash ? "NOT NULL" : "NULL"}
    ORDER BY updated_at DESC`).all() as ProjectSummary[];
  const folders = db.prepare(`SELECT f.id, f.name, f.created_at AS createdAt, f.updated_at AS updatedAt,
    COUNT(w.id) AS projectCount FROM project_folders f LEFT JOIN workflows w
    ON w.folder_id = f.id AND w.deleted_at IS NULL GROUP BY f.id ORDER BY f.updated_at DESC`).all() as ProjectFolder[];
  return { projects, folders };
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new CanvasSaveError("无效的项目或文件夹标识");
  return value;
}
function name(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 200) throw new CanvasSaveError("名称需为 1–200 个字符");
  return value.trim();
}

/** Validate the whole batch before changing anything; a stale tab cannot overwrite newer edits. */
export function manageWorkspace(value: unknown): { id?: string } {
  if (!value || typeof value !== "object") throw new CanvasSaveError("无效操作");
  const command = value as Record<string, unknown>;
  const db = getDatabase();
  return db.transaction(() => {
    const now = Date.now();
    const folder = (value: unknown) => {
      if (value === null) return null;
      const id = identifier(value);
      if (!db.prepare("SELECT 1 FROM project_folders WHERE id = ?").get(id)) throw new CanvasSaveError("文件夹已不存在，请刷新列表", 404);
      return id;
    };
    if (command.action === "create-project") {
      const id = identifier(command.id);
      const existing = db.prepare("SELECT 1 FROM workflows WHERE id = ?").get(id);
      saveWorkflow({ id, requestId: `workspace-create:${id}`, baseVersion: 0,
        snapshot: { name: "未命名项目", nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } });
      // Only the first creation assigns a folder. Replays still validate the save receipt
      // and deletion state, but a removed folder must not invalidate an accepted creation.
      if (!existing) {
        const folderId = folder(command.folderId);
        db.prepare("UPDATE workflows SET folder_id = ? WHERE id = ?").run(folderId, id);
      }
      return { id };
    }
    if (command.action === "create-folder") {
      const id = identifier(command.id);
      db.prepare("INSERT INTO project_folders (id, name, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING")
        .run(id, name(command.name), now, now);
      return { id };
    }
    if (command.action === "rename-folder" || command.action === "delete-folder") {
      const id = folder(command.id);
      if (id === null) throw new CanvasSaveError("请选择文件夹");
      if (command.action === "rename-folder") {
        db.prepare("UPDATE project_folders SET name = ?, updated_at = ? WHERE id = ?").run(name(command.name), now, id);
      } else {
        // Removing an organizer never deletes its projects, including recoverable projects.
        db.prepare("UPDATE workflows SET folder_id = NULL WHERE folder_id = ?").run(id);
        db.prepare("DELETE FROM project_folders WHERE id = ?").run(id);
      }
      return {};
    }
    const action = command.action;
    if (!["rename-project", "move", "trash", "restore", "purge"].includes(String(action))) throw new CanvasSaveError("不支持的操作");
    if (!Array.isArray(command.targets) || !command.targets.length) throw new CanvasSaveError("请选择项目");
    if (action === "rename-project" && command.targets.length !== 1) throw new CanvasSaveError("每次只能重命名一个项目");
    const targets = command.targets.map((target: unknown) => {
      if (!target || typeof target !== "object") throw new CanvasSaveError("无效项目");
      const { id: rawId, version } = target as { id: unknown; version: unknown };
      const id = identifier(rawId);
      const row = db.prepare("SELECT version, deleted_at, purged_at FROM workflows WHERE id = ?").get(id) as
        { version: number; deleted_at: number | null; purged_at: number | null } | undefined;
      if (!row || row.purged_at !== null) throw new CanvasSaveError("项目已不存在，请刷新列表", 404);
      if (row.version !== version) throw new CanvasSaveError("项目已有更新，请刷新列表后重试", 409);
      if ((row.deleted_at !== null) !== (action === "restore" || action === "purge")) throw new CanvasSaveError("项目状态已改变，请刷新列表", 409);
      return id;
    });
    const ids = [...new Set(targets)];
    const folderId = action === "move" ? folder(command.folderId) : null;
    const newName = action === "rename-project" ? name(command.name) : null;
    for (const id of ids) {
      if (action === "rename-project") db.prepare("UPDATE workflows SET name = ?, updated_at = ?, version = version + 1 WHERE id = ?").run(newName, now, id);
      if (action === "move") db.prepare("UPDATE workflows SET folder_id = ?, updated_at = ?, version = version + 1 WHERE id = ?").run(folderId, now, id);
      if (action === "trash") db.prepare("UPDATE workflows SET deleted_at = ?, version = version + 1 WHERE id = ?").run(now, id);
      if (action === "restore") {
        db.prepare("UPDATE workflows SET deleted_at = NULL, updated_at = ?, version = version + 1 WHERE id = ?").run(now, id);
        db.prepare("DELETE FROM canvas_save_receipts WHERE canvas_id = ?").run(id);
      }
      if (action === "purge") {
        // Retain only an identity tombstone so old/offline save requests cannot recreate the project.
        db.prepare("UPDATE workflows SET name = '', data = '{}', cover_url = NULL, node_count = 0, folder_id = NULL, purged_at = ?, version = version + 1 WHERE id = ?").run(now, id);
        db.prepare("DELETE FROM canvas_save_receipts WHERE canvas_id = ?").run(id);
      }
    }
    return {};
  }).immediate();
}
