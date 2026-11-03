import { isCompatibleCanvasConnection } from '@/lib/canvas/connections';
import type { Edge } from '@xyflow/react';
import type { CanvasNode } from '@/types';
import { NodeType } from '@/types';

/** Top-level selected roots carry their descendants; never reparent a subtree twice. */
export function selectedRoots(nodes: CanvasNode[], ids: string[]): CanvasNode[] {
  const selected = new Set(ids);
  const byId = new Map(nodes.map(node => [node.id, node]));
  return nodes.filter(node => {
    if (!selected.has(node.id)) return false;
    let parent = node.parentId;
    const visited = new Set([node.id]);
    while (parent) {
      if (visited.has(parent)) throw new Error('分组父子关系存在循环');
      visited.add(parent);
      if (selected.has(parent)) return false;
      parent = byId.get(parent)?.parentId;
    }
    return true;
  });
}

export function descendants(nodes: CanvasNode[], ids: string[]): Set<string> {
  const children = new Map<string, string[]>();
  for (const node of nodes) if (node.parentId) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node.id]);
  const removed = new Set<string>();
  const pending = [...ids];
  while (pending.length) {
    const id = pending.pop()!;
    if (removed.has(id)) continue;
    removed.add(id);
    pending.push(...(children.get(id) ?? []));
  }
  return removed;
}

export function groupGraphNodes(nodes: CanvasNode[], ids: string[], groupId: string): CanvasNode[] {
  const roots = selectedRoots(nodes, ids);
  if (!roots.length) return nodes;
  const byId = new Map(nodes.map(node => [node.id, node]));
  const absolute = (node: CanvasNode) => {
    let { x, y } = node.position;
    let parent = node.parentId;
    const visited = new Set([node.id]);
    while (parent) {
      if (visited.has(parent)) throw new Error('分组父子关系存在循环');
      visited.add(parent);
      const ancestor = byId.get(parent);
      if (!ancestor) throw new Error('分组父节点不存在');
      x += ancestor.position.x; y += ancestor.position.y; parent = ancestor.parentId;
    }
    return { x, y };
  };
  const positions = new Map(roots.map(node => [node.id, absolute(node)]));
  const minX = Math.min(...[...positions.values()].map(p => p.x));
  const minY = Math.min(...[...positions.values()].map(p => p.y));
  const maxX = Math.max(...roots.map(node => positions.get(node.id)!.x + (node.measured?.width ?? (Number(node.style?.width) || 320))));
  const maxY = Math.max(...roots.map(node => positions.get(node.id)!.y + (node.measured?.height ?? (Number(node.style?.height) || 240))));
  const group: CanvasNode = { id: groupId, type: NodeType.GROUP, position: { x: minX - 40, y: minY - 40 },
    data: { label: 'Group', type: NodeType.GROUP }, style: { width: maxX - minX + 80, height: maxY - minY + 80 }, draggable: true };
  return [group, ...nodes.map(node => {
    const position = positions.get(node.id);
    return position ? { ...node, parentId: groupId, extent: 'parent' as const,
      position: { x: position.x - group.position.x, y: position.y - group.position.y } } : node;
  })];
}

export function ungroupGraphNodes(nodes: CanvasNode[], groupId: string): CanvasNode[] {
  const group = nodes.find(node => node.id === groupId && node.type === NodeType.GROUP);
  if (!group) return nodes;
  return nodes.filter(node => node.id !== groupId).map(node => node.parentId === groupId ? { ...node,
    parentId: group.parentId, extent: group.parentId ? 'parent' as const : undefined,
    position: { x: node.position.x + group.position.x, y: node.position.y + group.position.y } } : node);
}

/** Reject a whole structural operation before publishing nodes or cancelling tasks. */
export function assertCanvasGraph(nodes: CanvasNode[], edges: Edge[]): void {
  if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new Error('画布节点与连线格式错误');
  const byId = new Map<string, CanvasNode>();
  for (const node of nodes) {
    if (!node || typeof node.id !== 'string' || !node.id || byId.has(node.id) ||
        !node.position || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y) ||
        !node.data || !Object.values(NodeType).includes(node.data.type) || node.type !== node.data.type) {
      throw new Error('画布节点身份、类型或位置无效');
    }
    byId.set(node.id, node);
  }
  for (const node of nodes) {
    const visited = new Set([node.id]);
    let parent = node.parentId;
    while (parent) {
      const group = byId.get(parent);
      if (!group || group.type !== NodeType.GROUP || visited.has(parent)) throw new Error('分组父子关系无效');
      visited.add(parent); parent = group.parentId;
    }
  }
  const seen = new Set<string>();
  const adjacency = new Map<string, Set<string>>();
  const incoming = new Map(nodes.map(node => [node.id, 0]));
  for (const edge of edges) {
    if (!edge || typeof edge.id !== 'string' || !edge.id || seen.has(edge.id) ||
        adjacency.get(edge.source)?.has(edge.target) ||
        !isCompatibleCanvasConnection(edge, byId.get(edge.source), byId.get(edge.target))) {
      throw new Error('连线无效：请检查节点类型或重复连线');
    }
    seen.add(edge.id);
    const targets = adjacency.get(edge.source) ?? new Set<string>();
    targets.add(edge.target); adjacency.set(edge.source, targets);
    incoming.set(edge.target, incoming.get(edge.target)! + 1);
  }
  const pending = nodes.filter(node => incoming.get(node.id) === 0).map(node => node.id);
  let visited = 0;
  while (pending.length) {
    const id = pending.pop()!;
    visited++;
    for (const target of adjacency.get(id) ?? []) {
      const count = incoming.get(target)! - 1;
      incoming.set(target, count);
      if (!count) pending.push(target);
    }
  }
  if (visited !== nodes.length) throw new Error('连线存在循环');
}

export function parentFirst(nodes: CanvasNode[]): CanvasNode[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const ordered: CanvasNode[] = [];
  const visited = new Set<string>();
  const visit = (node: CanvasNode) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    if (node.parentId) visit(byId.get(node.parentId)!);
    ordered.push(node);
  };
  nodes.forEach(visit);
  return ordered;
}
