import type { NodeData } from '@/types';

type MaterialSource = { id: string; name: string; kind: 'image' | 'video'; url?: string };
type SourceGraph = { nodes: { id: string; data: NodeData }[]; edges: { source: string; target: string }[] };

/** Per-consumer selector: geometry never enters the subscription's value. */
export function createVideoSourcesSelector(target: string, { includeGeometry = false } = {}) {
  let previous: MaterialSource[] = [];
  let previousNodes: SourceGraph["nodes"] = [];
  return (state: SourceGraph) => {
    const sources: MaterialSource[] = [];
    const nodes: SourceGraph["nodes"] = [];
    const byId = new Map(state.nodes.map(node => [node.id, node]));
    for (const edge of state.edges) {
      if (edge.target !== target) continue;
      const node = byId.get(edge.source);
      if (!node) continue;
      nodes.push(node);
      sources.push({ id: node.id, name: node.data.customTitle || node.data.label,
        kind: node.data.videoSrc ? 'video' : 'image',
        url: node.data.videoSrc || node.data.characterData?.referenceImages[0] || node.data.imageSrc });
    }
    // Experiments restore the original whole-node dependency, including material
    // recomputation on position updates, rather than merely simulating renders.
    const sameGeometry = !includeGeometry || nodes.every((node, index) => node === previousNodes[index]);
    if (sources.length === previous.length && sameGeometry && sources.every((source, index) => {
      const before = previous[index];
      return source.id === before.id && source.name === before.name && source.kind === before.kind && source.url === before.url;
    })) return previous;
    previousNodes = nodes;
    previous = sources;
    return sources;
  };
}
