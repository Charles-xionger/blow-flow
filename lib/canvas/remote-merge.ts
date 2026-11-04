import { isValidCanvasConnection } from './connections';
import { assertCanvasGraph } from './graph';
import { detachReferences } from './prompt';
import { versionContent } from './content-version';
import type { CanvasNode } from '../../types';
import { Immer, enablePatches } from 'immer';
import type { Node, Edge } from '@xyflow/react';
import { initialHistory, createCanvasHistory } from './history';
import { resolveHistoryMedia } from './history-media';
import { canonicalJSON, type CanvasSnapshot } from './save-protocol';
enablePatches();
const immer = new Immer({ autoFreeze: false });
type Item = Node | Edge;
/** Convert differences between two authoritative states into ID-addressed edits.
 * Array patches are evaluated only on their original timeline, never on local content. */
function mergeItems<T extends Item>(before: T[], after: T[], local: T[]): T[] {
    const old = new Map(before.map(item => [item.id, item]));
    const next = new Map(after.map(item => [item.id, item]));
    const result = local.filter(item => !old.has(item.id) || next.has(item.id)).map(item => {
        const previous = old.get(item.id), incoming = next.get(item.id);
        if (!previous || !incoming) return item;
        const changed = { ...item } as Record<string, unknown>;
        for (const key of new Set([...Object.keys(previous), ...Object.keys(incoming)])) {
            const a = previous as unknown as Record<string, unknown>, b = incoming as unknown as Record<string, unknown>;
            if (canonicalJSON(a[key]) === canonicalJSON(b[key])) continue;
            if (key === 'data') {
                const data = { ...changed.data as Record<string, unknown> };
                const av = a.data as Record<string, unknown>, bv = b.data as Record<string, unknown>;
                for (const field of new Set([...Object.keys(av), ...Object.keys(bv)])) {
                    if (canonicalJSON(av[field]) === canonicalJSON(bv[field])) continue;
                    if (bv[field] === undefined) delete data[field]; else data[field] = bv[field];
                }
                changed.data = data;
            } else if (b[key] === undefined) delete changed[key]; else changed[key] = b[key];
        }
        return changed as T;
    });
    const localIds = new Set(local.map(item => item.id));
    for (const item of after) if (!old.has(item.id) && !localIds.has(item.id)) result.push(item);
    return result;
}
export class NonAgentRemoteChange extends Error {}
export function mergeRemoteCanvas(base: CanvasSnapshot, local: CanvasSnapshot, remote: CanvasSnapshot): CanvasSnapshot {
    const prefix = base.history?.operations ?? [];
    const remoteOps = remote.history?.operations ?? [];
    if (!remote.history || !prefix.every((op, index) => remoteOps[index]?.id === op.id)) throw new Error('Remote history has no common baseline');
    if (remoteOps.slice(prefix.length).some(op => !local.history?.receipts.includes(op.id) && op.source !== 'agent'))
        throw new NonAgentRemoteChange('Remote changes require conflict recovery');
    let authoritative = { nodes: base.nodes, edges: base.edges, name: base.name };
    let state = { nodes: local.nodes, edges: local.edges, projectName: local.name, history: local.history, canvasSession: 0 };
    const history = createCanvasHistory(() => state, update => { state = { ...state, ...update }; });
    let batch: string | undefined;
    for (const operation of remoteOps.slice(prefix.length)) {
        const next = immer.applyPatches(authoritative, resolveHistoryMedia(operation.patches, remote.history.assets));
        if (!state.history?.receipts.includes(operation.id)) {
            const key = operation.batchId ?? operation.id;
            if (key !== batch) { history.end(); history.begin(key); batch = key; }
            let nodes = mergeItems(authoritative.nodes, next.nodes, state.nodes);
            let ids = new Set(nodes.map(node => node.id));
            while (nodes.some(node => node.parentId && !ids.has(node.parentId))) {
                nodes = nodes.filter(node => !node.parentId || ids.has(node.parentId));
                ids = new Set(nodes.map(node => node.id));
            }
            const edges: Edge[] = [];
            for (const edge of mergeItems(authoritative.edges, next.edges, state.edges)) {
                if (ids.has(edge.source) && ids.has(edge.target) && isValidCanvasConnection(edge, nodes as CanvasNode[], edges)) edges.push(edge);
            }
            nodes = nodes.map(node => {
                const prompt = detachReferences(node.data.prompt as CanvasNode['data']['prompt'], [...next.nodes, ...state.nodes] as CanvasNode[], ref => !edges.some(edge => edge.target === node.id && edge.source === ref));
                return prompt === node.data.prompt ? node : { ...node, data: { ...node.data, prompt } };
            });
            assertCanvasGraph(nodes as CanvasNode[], edges);
            history.change({ nodes: versionContent(state.nodes as CanvasNode[], nodes as CanvasNode[], edges, undefined, state.edges), edges, projectName: authoritative.name !== next.name ? next.name : state.projectName },
                { record: true, id: operation.id, source: operation.source, label: operation.label ?? '助手编辑' });
        }
        authoritative = next;
    }
    history.end();
    // An unlogged writer cannot be safely interpreted as an Agent edit.
    const clean = (snapshot: { nodes: Node[]; edges: Edge[]; name: string }) => {
        const projected = initialHistory({ ...snapshot, projectName: snapshot.name });
        return canonicalJSON(resolveHistoryMedia(projected.checkpoint, projected.assets));
    };
    if (clean(authoritative) !== clean(remote)) throw new Error('Remote content changed outside its history');
    return { ...local, nodes: state.nodes, edges: state.edges, name: state.projectName, history: state.history };
}
