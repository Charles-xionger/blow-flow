"use client";

import { CanvasPreview } from "@/components/ui/canvas-preview";

import { useRef, useState, type PointerEvent } from "react";
import { X } from "lucide-react";
import type { UpstreamNode } from "@/lib/canvas/prompt";
import { useCanvasStore } from "@/store/useCanvasStore";

export const upstreamTitle = (node: UpstreamNode) => node.label === node.name ? node.name : `${node.label} · ${node.name}`;

/** Thumbnail of an upstream node, or a text mark when it has no image. */
export function UpstreamThumbnail({ node, className }: { node: UpstreamNode; className: string }) {
  return node.src
    ? <CanvasPreview compact src={node.src} alt="" draggable={false} className={`${className} object-cover`} />
    : <span aria-hidden className={`${className} flex items-center justify-center bg-zinc-700 text-zinc-300`}>{node.kind === "text" ? "文" : node.kind === "video" ? "视" : "图"}</span>;
}

/** Connection layer of the node console. Dragging previews locally and commits the order on release. */
export function NodeConnections({ nodeId, upstream }: { nodeId: string; upstream: UpstreamNode[] }) {
  const [drag, setDrag] = useState<{ id: string; order: string[] } | null>(null);
  const items = useRef(new Map<string, HTMLLIElement>());
  if (!upstream.length) return null;

  const disconnect = (source: string) => {
    const { edges, onEdgesChange } = useCanvasStore.getState();
    onEdgesChange(edges.filter(edge => edge.source === source && edge.target === nodeId).map(edge => ({ type: "remove", id: edge.id })));
  };
  const startDrag = (event: PointerEvent<HTMLUListElement>) => {
    const target = event.target as Element;
    const id = target.closest("li")?.dataset.source;
    if (event.button !== 0 || !id || target.closest("button")) return;
    // Capture on the list: reordering moves the items in the DOM, which would release theirs.
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ id, order: upstream.map(node => node.id) });
  };
  const moveDrag = (event: PointerEvent<HTMLUListElement>) => {
    if (!drag) return;
    // Screen coordinates on both sides, so this holds at every canvas zoom.
    const distance = (id: string) => {
      const box = items.current.get(id)?.getBoundingClientRect();
      return box ? Math.hypot(box.x + box.width / 2 - event.clientX, box.y + box.height / 2 - event.clientY) : Infinity;
    };
    const nearest = drag.order.reduce((best, id) => distance(id) < distance(best) ? id : best);
    if (nearest === drag.id) return;
    const order = drag.order.filter(id => id !== drag.id);
    order.splice(drag.order.indexOf(nearest), 0, drag.id);
    setDrag({ ...drag, order });
  };
  const endDrag = () => {
    if (drag && drag.order.some((id, index) => id !== upstream[index]?.id)) useCanvasStore.getState().reorderUpstream(nodeId, drag.order);
    setDrag(null);
  };

  const shown = drag ? drag.order.flatMap(id => upstream.find(node => node.id === id) ?? []) : upstream;
  return (
    <ul aria-label="连接的上游节点" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onLostPointerCapture={() => setDrag(null)}
      className="flex touch-none select-none flex-wrap items-center gap-1.5">
      {shown.map(node => (
        <li key={node.id} data-source={node.id} title={upstreamTitle(node)} aria-label={upstreamTitle(node)}
          ref={element => { if (element) items.current.set(node.id, element); else items.current.delete(node.id); }}
          className={`group relative ${drag ? "cursor-grabbing" : "cursor-grab"} ${drag?.id === node.id ? "opacity-50" : ""}`}>
          <UpstreamThumbnail node={node} className="h-9 w-9 rounded-lg text-[11px]" />
          <button type="button" aria-label={`断开 ${upstreamTitle(node)}`} title="断开连接" onClick={() => disconnect(node.id)}
            className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-zinc-900 text-zinc-300 opacity-0 ring-1 ring-white/20 hover:text-white focus:opacity-100 group-hover:opacity-100">
            <X size={10} />
          </button>
        </li>
      ))}
    </ul>
  );
}
