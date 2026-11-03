import type { NodeData } from '@/types';

type MaterialSource = { id: string; name: string; kind: 'image' | 'video'; url?: string };
type SourceGraph = { nodes: { id: string; data: NodeData }[]; edges: { source: string; target: string }[] };

/** Per-consumer selector: geometry never enters the subscription's value. */
export function createVideoSourcesSelector(target: string) {
  let previous: MaterialSource[] = [];
  return (state: SourceGraph) => {
    const sources: MaterialSource[] = [];
    for (const edge of state.edges) {
      if (edge.target !== target) continue;
      const node = state.nodes.find(node => node.id === edge.source);
      if (!node) continue;
      sources.push({ id: node.id, name: node.data.customTitle || node.data.label,
        kind: node.data.videoSrc ? 'video' : 'image',
        url: node.data.videoSrc || node.data.characterData?.referenceImages[0] || node.data.imageSrc });
    }
    if (sources.length === previous.length && sources.every((source, index) => {
      const before = previous[index];
      return source.id === before.id && source.name === before.name && source.kind === before.kind && source.url === before.url;
    })) return previous;
    previous = sources;
    return sources;
  };
}
