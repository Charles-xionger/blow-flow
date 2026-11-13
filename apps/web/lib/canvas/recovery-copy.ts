import { migrateScriptSnapshot } from './script-migration';
import { remapImageReferenceOrder } from '../generation/image-references';
import { copiedGenerationData } from '../generation/recovery';
import { remapPromptReferences, type Prompt } from './prompt';
import type { CanvasSnapshot } from './save-protocol';

/** Copies get fresh node identities so independent task-recovery records cannot attach. */
export function recoverySnapshot(snapshot: CanvasSnapshot): CanvasSnapshot {
  snapshot = migrateScriptSnapshot(snapshot);
  const ids = new Map(snapshot.nodes.map(node => [node.id, crypto.randomUUID()]));
  return { ...snapshot, history: undefined,
    nodes: snapshot.nodes.map(node => ({ ...node, id: ids.get(node.id)!,
      parentId: node.parentId ? ids.get(node.parentId) : undefined,
      data: { ...node.data, ...copiedGenerationData,
        imageReferenceOrder: remapImageReferenceOrder(node.data.imageReferenceOrder as string[] | undefined, ids),
        prompt: remapPromptReferences(node.data.prompt as Prompt | undefined, ids) } })),
    edges: snapshot.edges.map(edge => ({ ...edge, id: crypto.randomUUID(),
      source: ids.get(edge.source)!, target: ids.get(edge.target)! })),
  };
}
