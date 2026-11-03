import type { Connection, Edge } from "@xyflow/react";
import { NodeType, type CanvasNode } from "@/types";
import { nodeDefinitions } from "@/lib/canvas/node-definitions";

/** Shared by xyflow's preview and store mutations; null handles support old drafts. */
export function isCompatibleCanvasConnection(connection: Connection | Edge, from?: CanvasNode, to?: CanvasNode): boolean {
  const { source, target, sourceHandle, targetHandle } = connection;
  if (!source || !target || source === target) return false;
  if (sourceHandle && sourceHandle !== "output") return false;
  if (targetHandle && targetHandle !== "input") return false;
  if (!from || !to) return false;
  const output = nodeDefinitions[from.data.type];
  const input = nodeDefinitions[to.data.type];
  const acceptsVideo = to.data.type === NodeType.IMAGE_TO_VIDEO && to.data.model === 'runninghub-h3';
  if (!output || !input?.input || !output.outputs.some((type) => input.accepts.includes(type) || (acceptsVideo && type === 'video'))) return false;
  return true;
}

export function isValidCanvasConnection(connection: Connection | Edge, nodes: CanvasNode[], edges: Edge[]): boolean {
  const { source, target } = connection;
  if (!isCompatibleCanvasConnection(connection, nodes.find(node => node.id === source), nodes.find(node => node.id === target))) return false;
  if (edges.some((edge) => edge.source === source && edge.target === target)) return false;
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = adjacency.get(edge.source) ?? [];
    targets.push(edge.target);
    adjacency.set(edge.source, targets);
  }
  const pending = [target];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === source) return false;
    if (visited.has(id)) continue;
    visited.add(id);
    pending.push(...(adjacency.get(id) ?? []));
  }
  return true;
}
