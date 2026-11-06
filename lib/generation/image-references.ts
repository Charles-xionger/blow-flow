import type { NodeData } from '../../types';
import { expandPrompt, promptSegments, promptWithLabels, referenceMaterials } from '../canvas/prompt';

type Graph = Parameters<typeof referenceMaterials>[1];
export interface ImageReference { id: string; url: string; name: string; sourceNodeId?: string; hasAlpha?: boolean }
/** Stable identities preserve user order while connected nodes change their original output. */
export function imageReferences(nodeId: string, graph: Graph): ImageReference[] {
  const data = graph.nodes.find(node => node.id === nodeId)?.data as NodeData | undefined;
  const counts = new Map<string, number>();
  const connected = referenceMaterials(nodeId, graph).map(({ src, source }) => {
    const index = counts.get(source) ?? 0; counts.set(source, index + 1);
    return { id: `node:${source}:${index}`, url: src, name: graph.nodes.find(n => n.id === source)?.data.label ?? '连接图片', sourceNodeId: source };
  });
  const refs = new Map([...(data?.imageReferences ?? []), ...connected].map(ref => [ref.id, ref]));
  const result: ImageReference[] = [];
  for (const id of data?.imageReferenceOrder ?? []) { const ref = refs.get(id); if (ref) { result.push(ref); refs.delete(id); } }
  return [...result, ...refs.values()];
}
export function imagePrompt(nodeId: string, graph: Graph, references: ImageReference[]): string {
  const node = graph.nodes.find(n => n.id === nodeId);
  const labels = new Map<string, string>();
  for (const segment of promptSegments(node?.data.prompt)) {
    if ('ref' in segment) labels.set(segment.ref, expandPrompt(segment.ref, graph));
  }
  references.forEach((reference, i) => { if (reference.sourceNodeId && !references.slice(0,i).some(r => r.sourceNodeId === reference.sourceNodeId)) labels.set(reference.sourceNodeId, `图片${i + 1}`); });
  return promptWithLabels(node?.data.prompt, labels);
}

export function remapImageReferenceOrder(order: string[] | undefined, ids: ReadonlyMap<string, string>): string[] | undefined {
  return order?.map(id => {
    if (!id.startsWith('node:')) return id;
    const index = id.lastIndexOf(':');
    const source = id.slice(5, index);
    return ids.has(source) ? `node:${ids.get(source)}${id.slice(index)}` : id;
  });
}
