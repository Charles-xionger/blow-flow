import type { ProjectFolder, ProjectSummary, WorkspaceCommand } from "@/lib/workspace/types";

export type WorkspaceAction =
  | { kind: "create-folder" }
  | { kind: "rename-folder" | "delete-folder"; folder: ProjectFolder }
  | { kind: "rename-project" | "move" | "trash" | "restore" | "purge"; projects: ProjectSummary[] };

export interface ActionDialog {
  title: string;
  description: string;
  field?: { type: "name" | "folder"; initialValue: string };
  destructive?: boolean;
  confirmLabel?: string;
  successMessage?: string;
  command(value: string): WorkspaceCommand;
}

const namingDescription = "使用一个容易辨认的名称，方便下次找到它。";

/** Each action owns its complete dialog and command; the form renders field types only. */
export function workspaceActionDialog(action: WorkspaceAction, folderId: string | null): ActionDialog {
  const targets = "projects" in action ? action.projects.map(({ id, version }) => ({ id, version })) : [];
  switch (action.kind) {
    case "create-folder": {
      const id = crypto.randomUUID();
      return {
        title: "新建文件夹", description: namingDescription,
        field: { type: "name", initialValue: "" },
        command: name => ({ action: "create-folder", id, name }),
      };
    }
    case "rename-folder":
      return {
        title: "重命名文件夹", description: namingDescription,
        field: { type: "name", initialValue: action.folder.name },
        command: name => ({ action: "rename-folder", id: action.folder.id, name }),
      };
    case "delete-folder":
      return {
        title: "删除文件夹",
        description: `删除“${action.folder.name}”后，其中的项目将移回根目录，不会被删除。`,
        command: () => ({ action: "delete-folder", id: action.folder.id }),
      };
    case "rename-project":
      return {
        title: "重命名项目", description: namingDescription,
        field: { type: "name", initialValue: action.projects[0].name },
        command: name => ({ action: "rename-project", targets, name }),
      };
    case "move":
      return {
        title: "移动项目", description: "选择一个文件夹，或移回工作空间根目录。",
        field: { type: "folder", initialValue: folderId ?? "" },
        command: value => ({ action: "move", targets, folderId: value || null }),
      };
    case "trash":
      return {
        title: "移入回收站", successMessage: "已移入回收站",
        description: `将 ${action.projects.length} 个项目移入回收站，可随时恢复。后台生成任务会继续执行。`,
        command: () => ({ action: "trash", targets }),
      };
    case "restore":
      return {
        title: "恢复项目", successMessage: "项目已恢复",
        description: `恢复 ${action.projects.length} 个项目到原文件夹；原文件夹已删除时恢复到根目录。`,
        command: () => ({ action: "restore", targets }),
      };
    case "purge":
      return {
        title: "永久删除项目", destructive: true, confirmLabel: "永久删除",
        description: `永久删除 ${action.projects.length} 个项目的画布内容，此操作无法撤销。`,
        command: () => ({ action: "purge", targets }),
      };
  }
}
