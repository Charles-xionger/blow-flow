import type { Node, Edge } from '@xyflow/react';
import { Immer, enablePatches, type Patch } from 'immer';
import type { CanvasHistory } from './history';
import { resolveHistoryMedia } from './history-media';
import { isValidCanvasConnection } from './connections';
import { NodeType, type CanvasNode } from '../../types';

const legacy = (node: Node) => node.type === 'creativeDesc' || node.type === 'storyboard';
type Graph = { nodes: Node[]; edges: Edge[] };
type Content = Graph & { name: string };
enablePatches();
const immer = new Immer({ autoFreeze: false });

/** Pure, deterministic upgrade. Raw legacy data and disconnected edges remain archival evidence. */
export function migrateScriptGraph<T extends Graph>(graph: T, historicalOutputs: ReadonlySet<string> = new Set()): T {
  const sources = graph.nodes.filter(legacy);
  if (!sources.length) return graph;
  const ids = new Set(graph.nodes.map(node => node.id));
  const outputs = new Map<string, string[]>();
  const added: Node[] = [];
  const nodes = graph.nodes.map(node => {
    if (!legacy(node)) return node;
    const texts = graph.edges.filter(edge => edge.source === node.id).flatMap(edge => {
      const target = graph.nodes.find(value => value.id === edge.target && value.type === NodeType.TEXT);
      return target ? [target.id] : [];
    });
    // Existing outputs may have been edited or reordered. Never match by prose,
    // overwrite them, or fill in apparently missing shots beside them.
    const published = [...new Set(texts)];
    if (!published.length && !historicalOutputs.has(node.id) && Array.isArray(node.data.storyboardShots)) {
      node.data.storyboardShots.forEach((shot: unknown, index: number) => {
        if (!shot || typeof shot !== 'object' || !('description' in shot) || typeof shot.description !== 'string' || !shot.description) return;
        const base = `${node.id}:legacy-text:${index}`;
        let id = base, suffix = 0;
        while (ids.has(id)) id = `${base}:${++suffix}`;
        ids.add(id); published.push(id);
        added.push({ id, type: NodeType.TEXT, position: { x: node.position.x + 440, y: node.position.y + index * 240 },
          ...(node.parentId ? { parentId: node.parentId } : {}),
          data: { type: NodeType.TEXT, label: '分镜文本', textPurpose: 'storyboard',
            ...('title' in shot && typeof shot.title === 'string' ? { customTitle: shot.title } : {}),
            prompt: [{ text: shot.description }], legacyScriptOutput: { nodeId: node.id, index } } });
      });
    }
    outputs.set(node.id, published);
    const { storyboardShots, shotCount, optimizedPrompt, ...data } = node.data;
    void storyboardShots; void shotCount; void optimizedPrompt;
    return { ...node, type: NodeType.SCRIPT, data: { ...data, type: NodeType.SCRIPT,
      scriptPreset: 'storyboard', isLoading: false, error: undefined,
      legacyScriptArchive: { type: node.type, data: Object.fromEntries(Object.entries(node.data).filter(([key]) => !['activeToolbarItem', 'isStackOpen', 'isLoading', 'error', 'generationStatus', 'generationBlocked', 'generationCanRetrySave', 'generationSaving', 'generationTaskId', 'pendingGeneration', 'generationNodeId', 'generationContentVersion', 'generationBindingVersion', 'generationRevision', 'generationResultBlocked', 'generationResultArtifacts', 'pendingScript', 'pendingScriptPublish', 'scriptTaskId'].includes(key))),
        outgoingEdges: graph.edges.filter(edge => edge.source === node.id), outputNodeIds: published,
        notice: texts.length ? '已有文本保留原文；未匹配的旧镜头数据保存在迁移档案中。' : '旧结果按原文保留；迁移未调用模型。' } } };
  });
  nodes.push(...added);
  // Keep unrelated edges byte-for-byte; only migrated source connections need validation.
  const edges: Edge[] = graph.edges.filter(edge => !outputs.has(edge.source));
  for (const edge of graph.edges) {
    const output = outputs.get(edge.source);
    if (!output || output.includes(edge.target)) continue;
    for (const [index, source] of output.entries()) {
      const next = { ...edge, id: index === 0 ? edge.id : `${edge.id}:legacy-output:${index}`, source, sourceHandle: undefined };
      if (!edges.some(existing => existing.id === next.id) && isValidCanvasConnection(next, nodes as CanvasNode[], edges)) edges.push(next);
    }
  }
  const rewritten = nodes.map(node => {
    if (!Array.isArray(node.data.prompt)) return node;
    let changed = false;
    const prompt = node.data.prompt.flatMap(segment => {
      if (!segment || typeof segment !== 'object' || !('ref' in segment) || !outputs.has(segment.ref)) return segment;
      changed = true;
      const output = outputs.get(segment.ref)!;
      const connected = output.filter(id => edges.some(edge => edge.source === id && edge.target === node.id));
      if (connected.length) return connected.map(ref => ({ ref }));
      const source = graph.nodes.find(value => value.id === segment.ref)!;
      return { text: String(source.data.customTitle || source.data.label || source.id) };
    });
    return changed ? { ...node, data: { ...node.data, prompt, legacyPromptArchive: node.data.prompt } } : node;
  });
  return { ...graph, nodes: rewritten, edges };
}

/** Upgrade active undo/redo states as well as the visible graph; keep original audit operations. */
export function migrateScriptSnapshot<T extends Graph & { history?: CanvasHistory }>(snapshot: T, previous?: Graph & { history?: CanvasHistory }): T {
  const history = snapshot.history;
  // A retained historical text/edge proves that absence may be an intentional
  // deletion. Preserve stored shots in the archive instead of recreating that output.
  const textIds = new Set<string>(), historicalEdges: {source:string;target:string}[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, unknown>;
    if (item.type === NodeType.TEXT && typeof item.id === 'string') textIds.add(item.id);
    if (typeof item.source === 'string' && typeof item.target === 'string') historicalEdges.push({source:item.source,target:item.target});
    for (const child of Object.values(item)) visit(child);
  };
  if (history && !(history as CanvasHistory & {scriptMigration?:number}).scriptMigration) visit(history);
  if (previous) visit(previous);
  const historicalOutputs = new Set(historicalEdges.filter(edge => textIds.has(edge.target)).map(edge => edge.source));
  const migrate = <G extends Graph>(graph: G) => migrateScriptGraph(graph, historicalOutputs);
  const next = migrate(snapshot);
  if (!history) return next;
  // Include historical-only nodes: an old node may currently be deleted.
  if ((history as CanvasHistory & { scriptMigration?: number }).scriptMigration === 1) return next;
  const historical = JSON.stringify([history.checkpoint, history.baseline, history.records]);
  if (next === snapshot && !historical.includes('creativeDesc') && !historical.includes('storyboardShots') && !historical.includes('"type":"storyboard"')) return next;
  const records = new Map(history.records.map(record => [record.id, record]));
  const upgraded = new Map<string, CanvasHistory['records'][number]>();
  let current = resolveHistoryMedia(history.baseline ?? history.checkpoint, history.assets) as Content;
  const upgrade = (id: string) => {
    const record = records.get(id)!;
    const after = immer.applyPatches(current, resolveHistoryMedia(record.patches, history.assets));
    const beforeGraph = migrate(current), afterGraph = migrate(after);
    const patches = (value: Content): Patch[] => [
      { op: 'replace', path: ['nodes'], value: value.nodes },
      { op: 'replace', path: ['edges'], value: value.edges },
      { op: 'replace', path: ['name'], value: value.name },
    ];
    upgraded.set(id, { ...record, patches: patches(afterGraph), inverse: patches(beforeGraph) });
    current = after;
  };
  for (const id of history.undo) upgrade(id);
  for (const id of [...history.redo].reverse()) upgrade(id);
  const upgradedHistory = { ...history, scriptMigration: 1,
    checkpoint: migrate(resolveHistoryMedia(history.checkpoint, history.assets)),
    ...(history.baseline ? { baseline: migrate(resolveHistoryMedia(history.baseline, history.assets)) } : {}),
    records: history.records.map(record => upgraded.get(record.id) ?? record),
    notice: '旧创作节点已迁入脚本；撤销与重做保持新结构，原操作记录与旧数据档案仍保留。' };
  return { ...next, history: upgradedHistory };
}
