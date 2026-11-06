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

/** For a model with its own reference format, which gives each referenced node's label. */
export function promptWithLabels(prompt: Prompt | undefined, labels: ReadonlyMap<string, string>): string {
  return promptSegments(prompt).map(segment => 'text' in segment ? segment.text : labels.get(segment.ref) ?? '').join('');
}

export function appendPromptText(prompt: Prompt | undefined, text: string): Segment[] {
  const segments = promptSegments(prompt);
  const last = segments[segments.length - 1];
  return last && 'text' in last ? [...segments.slice(0, -1), { text: last.text + text }] : [...segments, { text }];
}

type PromptNodeData = Pick<NodeData, 'type' | 'label' | 'customTitle' | 'prompt' | 'imageSrc'> & {
  characterData?: { referenceImages?: string[] };
};
type PromptNode = { id: string; data: PromptNodeData };
export type PromptGraph = { nodes: readonly PromptNode[]; edges: readonly { source: string; target: string }[] };
export type UpstreamNode = { id: string; kind: 'text' | 'image' | 'video'; label: string; name: string; src?: string };

// Kept as literals so this module has no runtime dependency on the app's type modules.
const textSources: ReadonlySet<string> = new Set(['text']);
// Node types that take text input, so connecting a text node appends its reference.
const referencingNodeTypes: ReadonlySet<string> = new Set(['text', 'textToImage', 'textToVideo']);

/** The name shown as the node's title. */
export function nodeName(data: Pick<NodeData, 'type' | 'label' | 'customTitle'>): string {
  return data.customTitle || (data.type === 'text' ? '文本描述' : data.label);
}

const imagesOf = (data: PromptNodeData) => data.characterData?.referenceImages?.length ? data.characterData.referenceImages : data.imageSrc ? [data.imageSrc] : [];

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
  return referenceMaterials(nodeId, graph).map(material => material.src);
}

/** The images `referenceImages` sends, each with the upstream node it comes from. */
export function referenceMaterials(nodeId: string, graph: PromptGraph): { src: string; source: string }[] {
  return sourcesOf(nodeId, graph).filter(node => !textSources.has(node.data.type))
    .flatMap(node => imagesOf(node.data).map(src => ({ src, source: node.id })));
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

/** Turns references into `@名称` text. Returns the same prompt when none of them is detached. */
export function detachReferences(prompt: Prompt | undefined, nodes: readonly PromptNode[], isDetached: (ref: string) => boolean = () => true): Prompt | undefined {
  if (!Array.isArray(prompt) || !prompt.some(segment => 'ref' in segment && isDetached(segment.ref))) return prompt;
  const segments: Segment[] = [];
  for (const segment of prompt) {
    if ('ref' in segment && !isDetached(segment.ref)) { segments.push(segment); continue; }
    const data = 'ref' in segment ? nodes.find(node => node.id === segment.ref)?.data : undefined;
    const text = 'text' in segment ? segment.text : `@${data ? nodeName(data) : '节点'}`;
    const last = segments[segments.length - 1];
    if (last && 'text' in last) last.text += text; else segments.push({ text });
  }
  return segments;
}

/** For a copied graph whose nodes get new IDs. */
export function remapPromptReferences(prompt: Prompt | undefined, ids: ReadonlyMap<string, string>): Prompt | undefined {
  if (!Array.isArray(prompt)) return prompt;
  return prompt.map(segment => 'ref' in segment ? { ref: ids.get(segment.ref) ?? segment.ref } : segment);
}

/**
 * Prompts after the edges change from `before` to `after`: a broken connection turns its references
 * into text, and a new connection from a text node appends a reference. `nodes` must still hold
 * removed sources, for their names. Returns the same array when nothing changes.
 */
export function syncReferences<N extends PromptNode>(nodes: N[], before: PromptGraph['edges'], after: PromptGraph['edges']): N[] {
  const missingFrom = (edges: PromptGraph['edges'], others: PromptGraph['edges']) => {
    const kept = new Set(others.map(edge => `${edge.source}\0${edge.target}`));
    return edges.filter(edge => !kept.has(`${edge.source}\0${edge.target}`));
  };
  const broken = missingFrom(before, after);
  const added = missingFrom(after, before);
  if (!broken.length && !added.length) return nodes;
  return nodes.map(node => {
    const lost = new Set(broken.filter(edge => edge.target === node.id).map(edge => edge.source));
    const detached = detachReferences(node.data.prompt, nodes, ref => lost.has(ref));
    const gained = !referencingNodeTypes.has(node.data.type) ? [] : added.filter(edge => edge.target === node.id
      && textSources.has(nodes.find(source => source.id === edge.source)?.data.type ?? '')).map(edge => ({ ref: edge.source }));
    const prompt = gained.length ? [...promptSegments(detached), ...gained] : detached;
    return prompt === node.data.prompt ? node : { ...node, data: { ...node.data, prompt } };
  });
}
