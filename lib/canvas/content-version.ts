import type { CanvasNode } from '../../types';
import type { Edge } from '@xyflow/react';
import { canonicalJSON } from './save-protocol';

const runtimeData = new Set(['isLoading', 'error', 'generationTaskId', 'pendingGeneration', 'generationStatus',
  'generationBlocked', 'generationCanRetrySave', 'generationSaving', 'generationNodeId', 'generationContentVersion', 'generationBindingVersion', 'generationRevision', 'generationResultBlocked', 'generationResultArtifacts', 'activeToolbarItem', 'isStackOpen']);

// Content revisions are execution facts, not undoable values. Changing an input
// also protects downstream nodes whose generation consumed that input.
export function versionContent(before: CanvasNode[], after: CanvasNode[], edges: Edge[], resultNode?: string, previousEdges: Edge[] = edges): CanvasNode[] {
  const previous = new Map(before.map(node => [node.id, node]));
  const affected = new Set(after.filter(node => {
    const old = previous.get(node.id);
    return old && old !== node && [...new Set([...Object.keys(old.data), ...Object.keys(node.data)])].filter(key => !runtimeData.has(key)).some(key => old.data[key] !== node.data[key] && canonicalJSON(old.data[key]) !== canonicalJSON(node.data[key]));
  }).map(node => node.id));
  if (previousEdges !== edges) {
    const incoming = (items: Edge[]) => {
      const byTarget = new Map<string, Edge[]>();
      for (const edge of items) {
        const list = byTarget.get(edge.target) ?? [];
        list.push(edge); byTarget.set(edge.target, list);
      }
      return byTarget;
    };
    const beforeInputs = incoming(previousEdges);
    const afterInputs = incoming(edges);
    for (const target of new Set([...beforeInputs.keys(), ...afterInputs.keys()])) {
      const old = beforeInputs.get(target) ?? [];
      const next = afterInputs.get(target) ?? [];
      if (old.length !== next.length || old.some((edge, i) => edge.source !== next[i].source ||
          edge.sourceHandle !== next[i].sourceHandle || edge.targetHandle !== next[i].targetHandle)) affected.add(target);
    }
  }
  const pending = [...affected];
  while (pending.length) {
    const source = pending.pop()!;
    for (const edge of edges) if (edge.source === source && !affected.has(edge.target)) { affected.add(edge.target); pending.push(edge.target); }
  }
  return after.map(node => affected.has(node.id) && node.id !== resultNode ? { ...node,
    data: { ...node.data, generationContentVersion: (previous.get(node.id)?.data.generationContentVersion ?? 0) + 1 } } : node);
}

