import type { TextStreamPhase } from '../ai-services/text/stream-types';
export type ScriptPhase = 'preparing' | TextStreamPhase;
export const scriptPhaseLabel: Record<ScriptPhase, string> = { preparing: '校验参考输入', connecting: '连接模型中', waiting: '模型已连接，等待输出', thinking: '模型思考中，等待正文', writing: '正文输出中' };
export type ScriptStatus = 'queued' | 'running' | 'stopping' | 'stopped' | 'completed' | 'failed' | 'interrupted';
export interface ScriptInput {
  outputMode?: 'shots' | 'board' | 'workflow';
  storyboard?: import('./storyboard').StoryboardLimits;
  model: string;
  requirements: string;
  instruction: string;
  preset: string;
  references: { nodeId: string; label: string; type: 'text' | 'image'; content: string }[];
}
export interface CreateScriptTask { requestId: string; canvasId: string; nodeId: string; input: ScriptInput }
export interface ScriptTask {
  workflow?: import('./pipeline/types').StoryboardWorkflow;
  outputNodeId?: string;
  outputSaved?: boolean;
  id: string; requestId: string; canvasId: string; nodeId: string;
  input: ScriptInput; status: ScriptStatus; text: string; revision: number;
  createdAt: number; updatedAt: number; error?: string; phase?: ScriptPhase;
}
export const scriptActive = (status?: ScriptStatus) => status === 'queued' || status === 'running' || status === 'stopping';
export const scriptStatusLabel: Record<ScriptStatus, string> = {
  queued: '等待执行', running: '生成中', stopping: '停止处理中', stopped: '已停止',
  completed: '已完成', failed: '生成失败', interrupted: '生成中断',
};
