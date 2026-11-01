import type { Node } from "@xyflow/react";

function image(node: Node): string | null {
  const value = node.data.imageSrc;
  if (node.type?.toLowerCase().includes("video") || node.data.videoSrc || typeof value !== "string") return null;
  return /^(https?:\/\/|data:image\/|\/)/i.test(value) && !value.startsWith("//") ? value : null;
}

function generated(node: Node): boolean {
  return node.type === "textToImage" || node.type === "imageToImage";
}

/** Keep the latest changed image result across saves, even when node order is unchanged. */
export function projectCover(nodes: Node[], previousNodes: Node[] = [], previousCover: string | null = null): string | null {
  const candidates = nodes.filter(node => generated(node) && image(node));
  const previous = new Map(previousNodes.map(node => [node.id, image(node)]));
  const changed = candidates.filter(node => image(node) !== previous.get(node.id));
  if (changed.length) return image(changed[changed.length - 1]);
  if (previousCover && candidates.some(node => image(node) === previousCover)) return previousCover;
  if (candidates.length) return image(candidates[candidates.length - 1]);
  const fallback = nodes.find(node => image(node));
  return fallback ? image(fallback) : null;
}
