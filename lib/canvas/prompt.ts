import type { NodeData } from '@/types';

/** Saved form of a prompt (ADR 0005). `ref` is the upstream node ID. Knows nothing about the editor. */
export type Segment = { text: string } | { ref: string };
export type Prompt = string | Segment[];

export function promptSegments(prompt: Prompt | undefined): Segment[] {
  if (Array.isArray(prompt)) return prompt;
  return prompt ? [{ text: prompt }] : [];
}

/** The text sent to a model. */
export function promptText(prompt: Prompt | undefined): string {
  return promptSegments(prompt).map(segment => 'text' in segment ? segment.text : '').join('');
}

/** A prompt that expands to nothing but whitespace cannot run. */
export function promptIsEmpty(prompt: Prompt | undefined): boolean {
  return !promptText(prompt).trim();
}

type PromptNodeData = Pick<NodeData, 'type' | 'label' | 'customTitle' | 'prompt' | 'imageSrc'> & {
  characterData?: { referenceImages?: string[] };
};
type PromptNode = { id: string; data: PromptNodeData };
export type PromptGraph = { nodes: readonly PromptNode[]; edges: readonly { source: string; target: string }[] };
export type UpstreamNode = { id: string; kind: 'text' | 'image'; label: string; name: string; src?: string };

// Kept as literals so this module has no runtime dependency on the app's type modules.
const textSources: ReadonlySet<string> = new Set(['text', 'creativeDesc', 'storyboard']);

/** The name shown as the node's title. */
export function nodeName(data: Pick<NodeData, 'type' | 'label' | 'customTitle'>): string {
  return data.customTitle || (data.type === 'text' ? '文本描述' : data.label);
}

const imagesOf = (data: PromptNodeData) => data.characterData?.referenceImages ?? (data.imageSrc ? [data.imageSrc] : []);

/** Describe sources in connection order. An image's number is its position among the images actually sent. */
export function describeUpstream(sources: readonly PromptNode[]): UpstreamNode[] {
  let images = 0;
  return sources.map(({ id, data }) => {
    const name = nodeName(data);
    if (textSources.has(data.type)) return { id, kind: 'text', label: name, name };
    const own = imagesOf(data);
    const label = own.length ? `图片${images + 1}` : name;
    images += own.length;
    return { id, kind: 'image', label, name, ...(own[0] ? { src: own[0] } : {}) };
  });
}

const sourcesOf = (nodeId: string, graph: PromptGraph) => graph.edges.filter(edge => edge.target === nodeId)
  .flatMap(edge => graph.nodes.find(node => node.id === edge.source) ?? []);

export function upstreamNodes(nodeId: string, graph: PromptGraph): UpstreamNode[] {
  return describeUpstream(sourcesOf(nodeId, graph));
}

/** Connected material is used whether or not the prompt references it. */
export function referenceImages(nodeId: string, graph: PromptGraph): string[] {
  return sourcesOf(nodeId, graph).filter(node => !textSources.has(node.data.type)).flatMap(node => imagesOf(node.data));
}

/** The text sent to a model: exactly what the editor shows, with references resolved at run time. */
export function expandPrompt(nodeId: string, graph: PromptGraph): string {
  const expand = (id: string, ancestors: readonly string[]): string => {
    const path = [...ancestors, id];
    const upstream = upstreamNodes(id, graph);
    return promptSegments(graph.nodes.find(node => node.id === id)?.data.prompt).map(segment => {
      if ('text' in segment) return segment.text;
      const source = upstream.find(candidate => candidate.id === segment.ref);
      if (!source) return '';
      if (source.kind === 'image') return source.label;
      return path.includes(source.id) ? source.name : expand(source.id, path);
    }).join('');
  };
  return expand(nodeId, []);
}
