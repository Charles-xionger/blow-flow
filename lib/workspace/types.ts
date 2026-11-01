export interface ProjectSummary {
  id: string;
  name: string;
  folderId: string | null;
  coverUrl: string | null;
  nodeCount: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  version: number;
}

export interface ProjectFolder {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  projectCount: number;
}

export interface WorkspaceData {
  projects: ProjectSummary[];
  folders: ProjectFolder[];
}

export type ProjectTarget = Pick<ProjectSummary, "id" | "version">;
export type WorkspaceCommand =
  | { action: "create-project"; id: string; folderId: string | null }
  | { action: "create-folder"; id: string; name: string }
  | { action: "rename-folder"; id: string; name: string }
  | { action: "delete-folder"; id: string }
  | { action: "rename-project"; targets: ProjectTarget[]; name: string }
  | { action: "move"; targets: ProjectTarget[]; folderId: string | null }
  | { action: "trash" | "restore" | "purge"; targets: ProjectTarget[] };
