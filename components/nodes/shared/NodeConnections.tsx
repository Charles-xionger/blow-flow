"use client";

import type { UpstreamNode } from "@/lib/canvas/prompt";

export const upstreamTitle = (node: UpstreamNode) => node.label === node.name ? node.name : `${node.label} · ${node.name}`;

/** Thumbnail of an upstream node, or a text mark when it has no image. */
export function UpstreamThumbnail({ node, className }: { node: UpstreamNode; className: string }) {
  return node.src
    // eslint-disable-next-line @next/next/no-img-element
    ? <img src={node.src} alt="" draggable={false} className={`${className} object-cover`} />
    : <span aria-hidden className={`${className} flex items-center justify-center bg-zinc-700 text-zinc-300`}>{node.kind === "text" ? "文" : "图"}</span>;
}

/** Connection layer of the node console. */
export function NodeConnections({ upstream }: { upstream: UpstreamNode[] }) {
  if (!upstream.length) return null;
  return (
    <ul aria-label="连接的上游节点" className="flex flex-wrap items-center gap-1.5">
      {upstream.map(node => (
        <li key={node.id} title={upstreamTitle(node)} aria-label={upstreamTitle(node)}>
          <UpstreamThumbnail node={node} className="h-9 w-9 rounded-lg text-[11px]" />
        </li>
      ))}
    </ul>
  );
}
