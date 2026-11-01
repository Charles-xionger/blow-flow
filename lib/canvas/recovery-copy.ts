import { clearedGenerationAssociation } from '../generation/recovery';
import type { CanvasSnapshot } from './save-protocol';

/** Copies get fresh node identities so independent task-recovery records cannot attach. */
export function recoverySnapshot(snapshot: CanvasSnapshot): CanvasSnapshot {
  const ids = new Map(snapshot.nodes.map(node => [node.id, crypto.randomUUID()]));
  return { ...snapshot,
    nodes: snapshot.nodes.map(node => ({ ...node, id: ids.get(node.id)!,
      parentId: node.parentId ? ids.get(node.parentId) : undefined,
      data: { ...node.data, ...clearedGenerationAssociation, isLoading: false, error: undefined } })),
    edges: snapshot.edges.map(edge => ({ ...edge, id: crypto.randomUUID(),
      source: ids.get(edge.source)!, target: ids.get(edge.target)! })),
  };
}
