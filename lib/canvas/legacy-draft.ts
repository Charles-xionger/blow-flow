import { migrateScriptSnapshot } from './script-migration';
import { NodeType } from '../../types';
import { canvasSnapshot } from './snapshot';
import { validateSaveOperation, type CanvasSnapshot } from './save-protocol';

export const LEGACY_CANVAS_KEY = 'canvas-storage';

export function parseLegacyDraft(raw: string): { id: string | null; snapshot: CanvasSnapshot } {
  try {
    const envelope = JSON.parse(raw);
    const state = envelope?.state;
    if (envelope?.version !== 0 || !state || typeof state !== 'object' ||
        !(state.currentWorkflowId === null || typeof state.currentWorkflowId === 'string' && state.currentWorkflowId.length > 0)) {
      throw new Error('无效的旧草稿格式或版本');
    }
    const snapshot = migrateScriptSnapshot({ name: state.projectName, nodes: state.nodes, edges: state.edges, viewport: state.viewport });
    validateSaveOperation({ id: state.currentWorkflowId ?? 'legacy', requestId: 'migration', baseVersion: 0, snapshot });
    const ids = new Set(snapshot.nodes.map((node: { id: string }) => node.id));
    if (ids.size !== snapshot.nodes.length || snapshot.nodes.some((node: { id: string; type?: string; data: unknown; parentId?: string }) =>
      !node.id || !Object.values(NodeType).includes(node.type as NodeType) ||
      Array.isArray(node.data) || node.parentId && !ids.has(node.parentId)) ||
      new Set(snapshot.edges.map((edge: { id: string }) => edge.id)).size !== snapshot.edges.length ||
      snapshot.edges.some((edge: { id: string; source: string; target: string }) => !edge.id || !ids.has(edge.source) || !ids.has(edge.target))) {
      throw new Error('无效的画布节点或连线');
    }
    return { id: state.currentWorkflowId, snapshot: canvasSnapshot({ ...state, ...snapshot }) };
  } catch (error) {
    throw new Error(`旧草稿迁移失败：${error instanceof Error ? error.message : String(error)}。原始备份已保留。`);
  }
}

