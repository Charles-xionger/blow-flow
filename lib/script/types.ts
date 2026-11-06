export type ScriptStatus = 'queued' | 'running' | 'stopping' | 'stopped' | 'completed' | 'failed' | 'interrupted';
export interface ScriptInput {
  model: string;
  requirements: string;
  instruction: string;
  preset: string;
  references: { nodeId: string; label: string; type: 'text' | 'image'; content: string }[];
}
export interface CreateScriptTask { requestId: string; canvasId: string; nodeId: string; input: ScriptInput }
export interface ScriptTask {
  id: string; requestId: string; canvasId: string; nodeId: string;
  input: ScriptInput; status: ScriptStatus; text: string; revision: number;
  createdAt: number; updatedAt: number; error?: string;
}
export const scriptActive = (status?: ScriptStatus) => status === 'queued' || status === 'running' || status === 'stopping';
export const scriptStatusLabel: Record<ScriptStatus, string> = {
  queued: '等待执行', running: '生成中', stopping: '停止处理中', stopped: '已停止',
  completed: '已完成', failed: '生成失败', interrupted: '生成中断',
};
