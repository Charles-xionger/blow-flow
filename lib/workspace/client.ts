import type { WorkspaceCommand } from "./types";

const PENDING_PROJECT_KEY = "ai-flow-workspace-pending-project-v1";
type CreateProject = Extract<WorkspaceCommand, { action: "create-project" }>;

class WorkspaceRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function runWorkspaceCommand(command: WorkspaceCommand): Promise<{ id?: string }> {
  const response = await fetch("/api/workspace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new WorkspaceRequestError(result.error || "操作失败", response.status);
  return result.data;
}

function pendingProject(folderId: string | null): CreateProject {
  const saved = sessionStorage.getItem(PENDING_PROJECT_KEY);
  if (saved) {
    const command = JSON.parse(saved) as Partial<CreateProject>;
    if (command.action !== "create-project" || typeof command.id !== "string" || !command.id ||
      !(command.folderId === null || typeof command.folderId === "string")) {
      throw new Error("无法读取待确认的新建项目，请保留当前标签页并稍后重试");
    }
    return command as CreateProject;
  }
  const command: CreateProject = { action: "create-project", id: crypto.randomUUID(), folderId };
  // Persist before sending: a lost response must reuse the same project even after reload.
  sessionStorage.setItem(PENDING_PROJECT_KEY, JSON.stringify(command));
  return command;
}

function clearPendingProject(command: CreateProject) {
  if (sessionStorage.getItem(PENDING_PROJECT_KEY) === JSON.stringify(command)) {
    sessionStorage.removeItem(PENDING_PROJECT_KEY);
  }
}

export async function createWorkspaceProject(folderId: string | null): Promise<string> {
  const command = pendingProject(folderId);
  try {
    const result = await runWorkspaceCommand(command);
    if (result?.id !== command.id) throw new Error("新建结果待确认，请再次点击新建项目");
    clearPendingProject(command);
    return command.id;
  } catch (error) {
    // Only definitive rejection can discard the request. Network/server errors may follow a committed write.
    if (error instanceof WorkspaceRequestError && error.status >= 400 && error.status < 500 &&
      error.status !== 408 && error.status !== 429) clearPendingProject(command);
    throw error;
  }
}
