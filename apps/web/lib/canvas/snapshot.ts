import type { Node, Edge, Viewport } from '@xyflow/react';
import type { CanvasSnapshot } from './save-protocol';

type GraphState = { history?: CanvasSnapshot['history']; nodes: Node[]; edges: Edge[]; viewport: Viewport; projectName: string };
export function canvasSnapshot(state: GraphState): CanvasSnapshot {
  // UI-only xyflow and node-menu fields must not produce durable versions.
  const nodes = state.nodes.map(node => {
    const { selected, dragging, measured, resizing, width, height, ...content } = node;
    const { activeToolbarItem, isStackOpen, ...data } = content.data;
    void selected; void dragging; void measured; void resizing; void width; void height;
    void activeToolbarItem; void isStackOpen;
    return { ...content, data };
  });
  const edges = state.edges.map(edge => { const { selected, ...content } = edge; void selected; return content; });
  return { name: state.projectName, nodes, edges, viewport: state.viewport, ...(state.history ? { history: state.history } : {}) };
}
