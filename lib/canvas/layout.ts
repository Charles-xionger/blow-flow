import ELK from 'elkjs/lib/elk.bundled.js';
import type { Edge } from '@xyflow/react';
import type { CanvasNode } from '../../types';
import { selectedRoots } from './graph';
import { nodeDefinitions } from './node-definitions';
const size = (node: CanvasNode) => ({ width: Number(node.style?.width) || node.data.displaySize?.width || 320,
    height: Number(node.style?.height) || node.data.displaySize?.height || nodeDefinitions[node.data.type]?.height || 240 });
/** ELK orders only selected siblings. Parent-relative coordinates and unselected nodes remain intact. */
export async function layoutCanvas(nodes: CanvasNode[], edges: Edge[], ids: string[], added = false, nearId?: string, direction: 'RIGHT' | 'DOWN' = 'RIGHT') {
    const roots = added ? nodes.filter(node => ids.includes(node.id)) : selectedRoots(nodes, ids);
    const positions = new Map<string, { x: number; y: number }>();
    const depth = (id?: string): number => {
        let count = 0;
        const seen = new Set<string>();
        while (id) {
            if (seen.has(id)) throw new Error('Invalid group hierarchy');
            seen.add(id); count++; id = nodes.find(node => node.id === id)?.parentId;
        }
        return count;
    };
    const parents = [...new Set(roots.map(node => node.parentId))].sort((a, b) => depth(b) - depth(a));
    const elk = new ELK();
    for (const parentId of parents) {
        const scope = nodes.filter(node => roots.some(root => root.id === node.id) && node.parentId === parentId).sort((a, b) => a.id.localeCompare(b.id));
        const selected = new Set(scope.map(node => node.id));
        const graph = await elk.layout({ id: 'root', layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': direction,
            'elk.spacing.nodeNode': '100', 'elk.layered.spacing.nodeNodeBetweenLayers': '120', 'elk.randomSeed': '1' },
            children: scope.map(node => ({ id: node.id, ...size(node) })),
            edges: edges.filter(edge => selected.has(edge.source) && selected.has(edge.target)).map(edge => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })) });
        const obstacles = nodes.filter(node => node.parentId === parentId && !selected.has(node.id));
        const anchor = obstacles.find(node => node.id === nearId) ?? obstacles.at(-1);
        const offset = added && anchor ? { x: anchor.position.x + size(anchor).width + 120, y: anchor.position.y }
            : added && parentId ? { x: 40, y: 40 } : { x: Math.min(...scope.map(node => node.position?.x ?? 0)), y: Math.min(...scope.map(node => node.position?.y ?? 0)) };
        const overlap = () => (graph.children ?? []).some(child => obstacles.some(node => {
            const bounds = size(node), x = (child.x ?? 0) + offset.x, y = (child.y ?? 0) + offset.y;
            return x < node.position.x + bounds.width + 60 && x + child.width! + 60 > node.position.x && y < node.position.y + bounds.height + 60 && y + child.height! + 60 > node.position.y;
        }));
        while (overlap()) offset.y += 100;
        if (parentId) {
            const parent = nodes.find(node => node.id === parentId);
            if (!parent) throw new Error('Group does not exist');
            const width = Math.max(...(graph.children ?? []).map(child => (child.x ?? 0) + offset.x + child.width!)) + 40;
            const height = Math.max(...(graph.children ?? []).map(child => (child.y ?? 0) + offset.y + child.height!)) + 40;
            if (added && ids.includes(parentId)) nodes = nodes.map(node => node.id === parentId ? { ...node, style: { ...node.style, width: Math.max(size(node).width, width), height: Math.max(size(node).height, height) } } : node);
            else if (width > size(parent).width || height > size(parent).height) throw new Error('Selected group has insufficient space; enlarge it before arranging these children');
        }
        for (const child of graph.children ?? []) positions.set(child.id, { x: (child.x ?? 0) + offset.x, y: (child.y ?? 0) + offset.y });
    }
    return nodes.map(node => positions.has(node.id) ? { ...node, position: positions.get(node.id)! } : node);
}
