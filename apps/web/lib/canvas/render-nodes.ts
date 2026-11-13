import { NodeType, type CanvasNode } from '@/types';

const imageNodes = new WeakMap<CanvasNode, CanvasNode>();

/** Image previews size their own content; stored geometry remains untouched for persistence.
 * Cache by immutable source node so unrelated edits retain xyflow's reference fast path. */
export function canvasRenderNodes(nodes: CanvasNode[]): CanvasNode[] {
  return nodes.map(node => {
    if (node.data.displaySize) return node;
    if (node.type !== NodeType.TEXT_TO_IMAGE && node.type !== NodeType.IMAGE_TO_IMAGE) return node;
    let rendered = imageNodes.get(node);
    if (!rendered) {
      rendered = { ...node, width: undefined, height: undefined,
        style: { ...node.style, width: undefined, height: undefined } };
      imageNodes.set(node, rendered);
    }
    return rendered;
  });
}
