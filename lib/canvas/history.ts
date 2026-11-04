import { historyDetails } from './history-summary';
import { packHistoryMedia, resolveHistoryMedia } from './history-media';
import { Immer, enablePatches, type Patch } from 'immer';
import type { Node, Edge } from '@xyflow/react';
import { canonicalJSON } from './save-protocol';

enablePatches();
const immer = new Immer({ autoFreeze: false });

type Content = { nodes: Node[]; edges: Edge[]; name: string };
export interface HistoryOperation {
  source?: 'agent';
  time?: number;
  label?: string;
  details?: string[];
  id: string;
  batchId?: string;
  kind: 'edit' | 'undo' | 'redo' | 'boundary' | 'noop';
  patches: Patch[];
  inverse: Patch[];
}
export interface CanvasHistory {
  schema: 1;
  assets?: Record<string, string>;
  generations?: Record<string, Record<string, unknown>>;
  checkpoint: Content;
  baseline?: Content;
  operations: HistoryOperation[];
  records: { id: string; label: string; patches: Patch[]; inverse: Patch[]; time?: number }[];
  undo: string[];
  redo: string[];
  receipts: string[];
  notice?: string;
}
type State = { nodes: Node[]; edges: Edge[]; projectName: string; canvasSession: number; history?: CanvasHistory; selectedNodeIds?: string[] };
const generationFields = new Set(['generationTaskId', 'pendingGeneration', 'generationNodeId', 'generationContentVersion', 'generationBindingVersion', 'generationRevision', 'generationResultBlocked', 'generationResultArtifacts']);
const transientNode = new Set(['selected', 'dragging', 'measured', 'resizing', 'width', 'height']);
const transientData = new Set(['activeToolbarItem', 'isStackOpen', 'isLoading', 'error', 'generationStatus', 'generationBlocked', 'generationCanRetrySave', 'generationSaving', 'generationTaskId', 'pendingGeneration', 'generationNodeId', 'generationContentVersion', 'generationBindingVersion', 'generationRevision', 'generationResultBlocked', 'generationResultArtifacts']);
const omit = (value: Record<string, unknown>, keys: Set<string>) => Object.fromEntries(Object.entries(value).filter(([key, v]) => !keys.has(key) && v !== undefined));
const projectedNodes = new WeakMap<Node, Node>();
function content(state: Pick<State, 'nodes' | 'edges' | 'projectName'>): Content {
  return { name: state.projectName, nodes: state.nodes.map(node => {
    let projected = projectedNodes.get(node);
    if (!projected) {
      projected = { ...omit(node, transientNode), data: omit(node.data, transientData) } as Node;
      projectedNodes.set(node, projected);
    }
    return projected;
  }), edges: state.edges.map(({ selected, ...edge }) => { void selected; return edge; }) };
}
export function initialHistory(state: Pick<State, 'nodes' | 'edges' | 'projectName'>): CanvasHistory {
  return packHistoryMedia({ schema: 1, checkpoint: content(state), operations: [], records: [], undo: [], redo: [], receipts: [] });
}
function difference(before: Content, after: Content) {
  return immer.produceWithPatches(before, draft => {
    if (before.nodes.length !== after.nodes.length || before.nodes.some((node, i) => node.id !== after.nodes[i].id)) {
      draft.nodes = after.nodes;
    } else after.nodes.forEach((node, i) => {
      if (node === before.nodes[i]) return;
      const old = before.nodes[i];
      for (const key of new Set([...Object.keys(old), ...Object.keys(node)])) {
        if (key === 'data') {
          for (const field of new Set([...Object.keys(old.data), ...Object.keys(node.data)])) {
            if (canonicalJSON(old.data[field]) === canonicalJSON(node.data[field])) continue;
            if (node.data[field] === undefined) delete draft.nodes[i].data[field];
            else draft.nodes[i].data[field] = node.data[field];
          }
        } else if (canonicalJSON(old[key as keyof Node]) !== canonicalJSON(node[key as keyof Node])) {
          const target = draft.nodes[i] as unknown as Record<string, unknown>;
          if (node[key as keyof Node] === undefined) delete target[key];
          else target[key] = node[key as keyof Node];
        }
      }
    });
    if (canonicalJSON(before.edges) !== canonicalJSON(after.edges)) draft.edges = after.edges;
    if (before.name !== after.name) draft.name = after.name;
  });
}
function restore(state: State, next: Content) {
  // Runtime/task progress and selection belong to the live editor, never to patches.
  const live = new Map(state.nodes.map(node => [node.id, node]));
  const liveEdges = new Map(state.edges.map(edge => [edge.id, edge]));
  return { nodes: next.nodes.map(node => {
    const previous = live.get(node.id);
    const facts = !previous && state.history?.generations?.[node.id] ? resolveHistoryMedia(state.history.generations[node.id], state.history.assets) : {};
    if (previous && projectedNodes.get(previous) === node) return previous;
    const resized = previous?.style?.width !== node.style?.width || previous?.style?.height !== node.style?.height;
    return { ...node, ...Object.fromEntries(Object.entries(previous ?? {}).filter(([key]) => transientNode.has(key))),
      ...(resized ? { width: undefined, height: undefined, measured: undefined } : {}),
      data: { ...omit(node.data, transientData), ...facts, ...Object.fromEntries(Object.entries(previous?.data ?? {}).filter(([key]) => transientData.has(key))) } };
  }), edges: next.edges.map(edge => ({ ...edge, selected: liveEdges.get(edge.id)?.selected })), projectName: next.name, ...(state.selectedNodeIds ? { selectedNodeIds: state.selectedNodeIds.filter(id => next.nodes.some(node => node.id === id)) } : {}) };
}

const expectedContents = new WeakMap<CanvasHistory, Content>();
function expectedContent(history: CanvasHistory): Content {
  let expected = expectedContents.get(history);
  if (!expected) {
    const entries = new Map(history.records.map(entry => [entry.id, entry]));
    expected = history.undo.reduce((value, id) => immer.applyPatches(value, resolveHistoryMedia(entries.get(id)!.patches, history.assets)), resolveHistoryMedia(history.baseline ?? history.checkpoint, history.assets));
    expected = content({ nodes: expected.nodes, edges: expected.edges, projectName: expected.name });
    expectedContents.set(history, expected);
  }
  return expected;
}
function boundary(history: CanvasHistory, current: Content): CanvasHistory {
  return { ...history, baseline: current, undo: [], redo: [],
    notice: '检测到历史之外的内容变更；此前记录仍保留，当前撤销区间已重新开始。' };
}

export function restoredHistory(state: Pick<State, 'nodes' | 'edges' | 'projectName' | 'history'>): CanvasHistory {
  const history = state.history ?? initialHistory(state);
  const current = content(state);
  return difference(expectedContent(history), current)[1].length ? boundary(history, current) : history;
}

/** Single content mutation boundary. The caller supplies already computed changes; replay has no business side effects. */
export function createCanvasHistory(get: () => State, publish: (state: Partial<State>) => void, canRestore?: (next: Content) => Content | false) {
  const set = (update: Partial<State>) => {
    const state = get();
    let history = update.history ?? state.history;
    const expected = history ? expectedContents.get(history) : undefined;
    if (update.nodes && history && update.canvasSession === undefined) {
      const generations = { ...history.generations };
      const live = new Map(state.nodes.map(node => [node.id, node]));
      const candidates = [...state.nodes.filter(node => !generations[node.id]),
        ...update.nodes.filter(node => node.data !== live.get(node.id)?.data)];
      let changed = false;
      for (const node of candidates) {
        const facts = Object.fromEntries(Object.entries(node.data).filter(([key, value]) => generationFields.has(key) && value !== undefined));
        if (!Object.keys(facts).length && !generations[node.id]) continue;
        const prior = resolveHistoryMedia(generations[node.id] ?? {}, history.assets);
        const keys = Object.keys(facts);
        if (keys.length !== Object.keys(prior).length || keys.some(key => prior[key] !== facts[key] && canonicalJSON(prior[key]) !== canonicalJSON(facts[key]))) {
          generations[node.id] = facts; changed = true;
        }
      }
      if (changed) history = { ...history, generations };
    }
    if (history && (update.history || history !== state.history)) {
      const packed = packHistoryMedia(history);
      if (expected) expectedContents.set(packed, expected);
      update = { ...update, history: packed };
    }
    publish(update);
  };
  let batch: { key: string; session: number; before: Content; history: CanvasHistory; id: string } | undefined;
  function change(update: Partial<State>, options: { record?: boolean; id?: string; label?: string; source?: 'agent' } = {}) {
    const state = get();
    if (update.canvasSession !== undefined && update.canvasSession !== state.canvasSession) {
      batch = undefined; set({ ...update, history: update.history }); return;
    }
    if ('history' in update) { batch = undefined; set(update); return; }
    if (batch && batch.session !== state.canvasSession) batch = undefined;
    if (update.nodes === undefined && update.edges === undefined && update.projectName === undefined) { set(update); return; }
    let history = state.history ?? initialHistory(state);
    if (options.id && history.receipts.includes(options.id)) return;
    const next = { ...state, ...update };
    const before = content(state);
    if (difference(expectedContent(history), before)[1].length) { history = boundary(history, before); batch = undefined; }
    const after = content(next);
    const [, currentPatches, currentInverse] = difference(before, after);
    if (!currentPatches.length) {
      set({ ...update, ...(state.history && history !== state.history ? { history } : {}), ...(options.id ? { history: { ...history, receipts: [...history.receipts, options.id],
        operations: [...(history.operations ?? []), { id: options.id, ...(options.source ? { source: options.source } : {}), kind: 'noop', time: Date.now(), patches: [], inverse: [] }] } } : {}) }); return;
    }
    const operationId = options.id ?? crypto.randomUUID();
    const operation: HistoryOperation = { id: operationId, ...(options.source ? { source: options.source } : {}), batchId: batch?.id ?? operationId,
      time: Date.now(), label: options.label ?? '编辑', details: historyDetails(before, after),
      kind: options.record ? 'edit' : 'boundary', patches: currentPatches, inverse: currentInverse };
    const operations = [...(history.operations ?? []), operation];
    if (!options.record) {
      batch = undefined;
      const id = operationId;
      set({ ...update, history: { ...boundary(history, after), operations, records: [...history.records, { id, label: '外部内容变更', patches: currentPatches, inverse: [] }],
        receipts: [...history.receipts, id] } });
      return;
    }
    const [, patches, inverse] = difference(batch?.before ?? before, after);
    if (!patches.length) {
      set({ ...update, history: { ...(batch?.history ?? history), assets: history.assets, operations,
        receipts: [...history.receipts, operationId] } }); return;
    }
    const base = batch?.history ?? history;
    const id = batch?.id ?? operationId;
    const entry = { id, label: options.label ?? '编辑', patches, inverse,
      time: history.records.find(record => record.id === id)?.time ?? operation.time };
    const nextHistory: CanvasHistory = { ...base, assets: history.assets, operations, records: [...base.records, entry],
      undo: [...base.undo, id], redo: [], receipts: [...new Set([...history.receipts, operationId])] };
    expectedContents.set(nextHistory, after);
    set({ ...update, history: nextHistory });
  }
  function travel(direction: 'undo' | 'redo', id = crypto.randomUUID()) {
    batch = undefined;
    const state = get();
    const history = state.history;
    if (!history || history.receipts.includes(id)) return;
    if (difference(expectedContent(history), content(state))[1].length) {
      set({ history: boundary(history, content(state)) }); return;
    }
    const target = history[direction].at(-1);
    const entry = history.records.find(entry => entry.id === target);
    if (!entry) return;
    let next = immer.applyPatches(content(state), resolveHistoryMedia(direction === 'undo' ? entry.inverse : entry.patches, history.assets));
    const restored = restore(state, next);
    next = { ...next, nodes: restored.nodes, edges: restored.edges };
    if (canRestore) {
      const prepared = canRestore(next);
      if (!prepared) return;
      next = prepared;
    }
    const opposite = direction === 'undo' ? 'redo' : 'undo';
    set({ ...restored, nodes: next.nodes, edges: next.edges, history: { ...history,
      operations: [...(history.operations ?? []), { id, batchId: entry.id, kind: direction, time: Date.now(), label: entry.label, details: historyDetails(content(state), content({ ...state, nodes: next.nodes, edges: next.edges, projectName: next.name })),
        patches: direction === 'undo' ? entry.inverse : entry.patches,
        inverse: direction === 'undo' ? entry.patches : entry.inverse }],
      [direction]: history[direction].slice(0, -1),
      [opposite]: [...history[opposite], entry.id], receipts: [...history.receipts, id] } });
  }
  return { change,
    begin(key: string) {
      if (batch?.key === key && batch.session === get().canvasSession) return;
      const state = get();
      batch = { key, session: state.canvasSession, before: content(state), history: state.history ?? initialHistory(state), id: crypto.randomUUID() };
    },
    end(key?: string) { if (!key || batch?.key === key) batch = undefined; },
    undo: (id?: string) => travel('undo', id), redo: (id?: string) => travel('redo', id) };
}

/** Validate the persisted envelope before accepting it as part of a save. */
export function validateHistory(value: unknown, state: Pick<State, 'nodes' | 'edges' | 'projectName'>): void {
  const history = value as CanvasHistory;
  const validContent = (item: Content) => item && typeof item.name === 'string' && Array.isArray(item.nodes) && Array.isArray(item.edges);
  const strings = (items: unknown): items is string[] => Array.isArray(items) && items.every(item => typeof item === 'string');
  const patches = (items: Patch[]) => Array.isArray(items) && items.every(patch => patch && ['add', 'remove', 'replace'].includes(patch.op) &&
    Array.isArray(patch.path) && ['nodes', 'edges', 'name'].includes(String(patch.path[0])) &&
    patch.path.every(part => (typeof part === 'string' || Number.isSafeInteger(part)) && !['__proto__', 'constructor', 'prototype'].includes(String(part))));
  if (history?.assets && (!Object.values(history.assets).every(value => typeof value === 'string' && /^data:(image|video|audio)\//.test(value)))) throw new Error('Invalid history media');
  if (!history || history.schema !== 1 || !validContent(history.checkpoint) || (history.baseline && !validContent(history.baseline)) ||
      !Array.isArray(history.records) || !history.records.every(entry => entry && typeof entry.id === 'string' && typeof entry.label === 'string' && patches(entry.patches) && patches(entry.inverse)) ||
      !strings(history.undo) || !strings(history.redo) || !strings(history.receipts)) throw new Error('Invalid canvas history');
  if (history.operations !== undefined && (!Array.isArray(history.operations) || !history.operations.every(op => op && typeof op.id === 'string' &&
      (op.source === undefined || op.source === 'agent') && (op.batchId === undefined || typeof op.batchId === 'string') && ['edit', 'undo', 'redo', 'boundary', 'noop'].includes(op.kind) && patches(op.patches) && patches(op.inverse)))) throw new Error('Invalid canvas history operations');
  const metadata = (entry: { time?: number; label?: string; details?: string[] }) =>
    (entry.time === undefined || Number.isFinite(entry.time) && entry.time >= 0 && entry.time <= 8.64e15) &&
    (entry.label === undefined || typeof entry.label === 'string') &&
    (entry.details === undefined || strings(entry.details));
  if (!history.records.every(metadata) || !(history.operations ?? []).every(metadata)) throw new Error('Invalid history metadata');
  const ids = new Set(history.records.map(entry => entry.id));
  if (ids.size !== history.records.length || new Set([...history.undo, ...history.redo]).size !== history.undo.length + history.redo.length ||
      [...history.undo, ...history.redo].some(id => !ids.has(id))) throw new Error('Invalid canvas history position');
  try {
    if (canonicalJSON(expectedContent(history)) !== canonicalJSON(content(state))) throw new Error('Content mismatch');
  } catch { throw new Error('Invalid canvas history content'); }
}
