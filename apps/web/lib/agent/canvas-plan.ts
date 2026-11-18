import { versionContent } from '../canvas/content-version';
import { createCanvasHistory, type CanvasHistory } from '../canvas/history';
import { assertCanvasGraph, descendants } from '../canvas/graph';
import { isValidCanvasConnection } from '../canvas/connections';
import { promptSegments, syncReferences } from '../canvas/prompt';
import { assertOriginalMedia } from '../canvas/original-media';
import type { CanvasSnapshot } from '../canvas/save-protocol';
import { validateCanvasParameters } from './canvas-parameters';
import type { CanvasModel } from './canvas-models';
import type { Edge } from '@xyflow/react';
import { NodeType, type CanvasNode, type NodeData } from '../../types';

export type CanvasOperation =
  | { kind: 'create'; node: CanvasNode }
  | { kind: 'update'; id: string; data: Partial<NodeData> }
  | { kind: 'move'; id: string; position: { x: number; y: number } }
  | { kind: 'delete'; id: string }
  | { kind: 'connect'; edge: Edge }
  | { kind: 'disconnect'; id: string };

export type CanvasPlan = { snapshot: CanvasSnapshot; skipped: string[]; removedNodes: CanvasNode[] };

/** Compute an Agent edit with the same graph and undo rules as the editor. No storage access. */
export function planAgentCanvasEdit(current: CanvasSnapshot, identity: string, operations: CanvasOperation[],
  label = '助手编辑', options: { validateInput?: boolean; models?: CanvasModel[]; tombstoned?: (id: string) => boolean } = {}): CanvasPlan {
  if (!identity || !Array.isArray(operations) || operations.length > 100 || typeof label !== 'string') throw new Error('Invalid canvas step');
  const validateInput = options.validateInput ?? false;
  const models = options.models ?? [];
  let state = { nodes: current.nodes as CanvasNode[], edges: current.edges, projectName: current.name, canvasSession: 0, history: current.history as CanvasHistory | undefined };
  const history = createCanvasHistory(() => state, update => { state = { ...state, ...update } as typeof state; });
  const skipped: string[] = [];
  // A generated text result keeps its explicit prompt references when linked to its source.
  const authoredText = new Set(operations.flatMap(op => op.kind === 'create' && op.node.type === NodeType.TEXT && op.node.data.prompt !== undefined ? [op.node.id] : []));
  history.begin(identity);
  operations.forEach((operation, index) => {
    let { nodes, edges } = state;
    const beforeEdges = edges;
    if (operation.kind === 'create') {
      if (nodes.some(node => node.id === operation.node?.id)) throw new Error('Node already exists');
      if (options.tombstoned?.(operation.node.id)) throw new Error('Node identity was deleted');
      assertOriginalMedia(operation.node.data);
      const data = { ...operation.node.data, type: operation.node.data?.type ?? operation.node.type };
      if (data.type !== operation.node.type) throw new Error('node.data.type must match node.type');
      const node = validateInput ? { ...operation.node, data: { ...data, ...validateCanvasParameters(data, data, models) } } : { ...operation.node, data };
      nodes = [...nodes, node];
    } else if (operation.kind === 'connect') {
      if (!isValidCanvasConnection(operation.edge, nodes, edges)) throw new Error('Invalid connection');
      edges = [...edges, operation.edge];
    } else if (operation.kind === 'disconnect') {
      edges = edges.filter(edge => edge.id !== operation.id);
    } else {
      const node = nodes.find(node => node.id === operation.id);
      if (!node) { skipped.push(`${operation.id}: target deleted or absent`); return; }
      if (operation.kind === 'update') {
        assertOriginalMedia(operation.data);
        const data = validateInput ? validateCanvasParameters(node.data, operation.data, models) : operation.data;
        nodes = nodes.map(value => value.id === node.id ? { ...value, data: { ...value.data, ...data }, ...(operation.data.type ? { type: operation.data.type } : {}) } : value);
        edges = edges.filter(edge => isValidCanvasConnection(edge, nodes, edges.filter(other => other.id !== edge.id)));
      } else if (operation.kind === 'move') {
        nodes = nodes.map(value => value.id === node.id ? { ...value, position: operation.position } : value);
      } else if (operation.kind === 'delete') {
        const removed = descendants(nodes, [node.id]);
        edges = edges.filter(edge => !removed.has(edge.source) && !removed.has(edge.target));
        nodes = syncReferences(nodes, beforeEdges, edges).filter(value => !removed.has(value.id));
      } else throw new Error('Unknown canvas operation');
    }
    const referenceBaseline = operation.kind === 'connect' && authoredText.has(operation.edge.target) ? [...beforeEdges, operation.edge] : beforeEdges;
    nodes = syncReferences(nodes, referenceBaseline, edges);
    assertCanvasGraph(nodes, edges);
    nodes = versionContent(state.nodes, nodes, edges, undefined, state.edges);
    history.change({ nodes, edges }, { record: true, id: `${identity}:${index}`, source: 'agent', label });
  });
  history.end();
  if (validateInput) for (const node of state.nodes) for (const segment of promptSegments(node.data.prompt)) {
    if ('ref' in segment && !state.edges.some(edge => edge.target === node.id && edge.source === segment.ref)) throw new Error('Prompt reference requires an upstream connection');
  }
  const remaining = new Set(state.nodes.map(node => node.id));
  return {
    snapshot: { name: current.name, nodes: state.nodes, edges: state.edges, viewport: current.viewport, history: state.history },
    skipped,
    removedNodes: (current.nodes as CanvasNode[]).filter(node => !remaining.has(node.id)),
  };
}
