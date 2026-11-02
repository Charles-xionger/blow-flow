"use client";

import { X } from "lucide-react";
import type { UpstreamNode } from "@/lib/canvas/prompt";
import { useCanvasStore } from "@/store/useCanvasStore";

export const upstreamTitle = (node: UpstreamNode) => node.label === node.name ? node.name : `${node.label} · ${node.name}`;

/** Thumbnail of an upstream node, or a text mark when it has no image. */
export function UpstreamThumbnail({ node, className }: { node: UpstreamNode; className: string }) {
  return node.src
    // eslint-disable-next-line @next/next/no-img-element
    ? <img src={node.src} alt="" draggable={false} className={`${className} object-cover`} />
    : <span aria-hidden className={`${className} flex items-center justify-center bg-zinc-700 text-zinc-300`}>{node.kind === "text" ? "文" : "图"}</span>;
}

/** Connection layer of the node console. */
export function NodeConnections({ nodeId, upstream }: { nodeId: string; upstream: UpstreamNode[] }) {
  if (!upstream.length) return null;
  const disconnect = (source: string) => {
    const { edges, onEdgesChange } = useCanvasStore.getState();
    onEdgesChange(edges.filter(edge => edge.source === source && edge.target === nodeId).map(edge => ({ type: "remove", id: edge.id })));
  };
  return (
    <ul aria-label="连接的上游节点" className="flex flex-wrap items-center gap-1.5">
      {upstream.map(node => (
        <li key={node.id} title={upstreamTitle(node)} aria-label={upstreamTitle(node)} className="group relative">
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
