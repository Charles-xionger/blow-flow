import type { NodeData } from '@/types';

/** Only original references enter content history; preview and object URLs are ephemeral. */
export function assertOriginalMedia(data: Partial<NodeData>): void {
  const sources = [data.imageSrc, data.videoSrc, ...(data.inputImages ?? []), ...(data.outputArtifacts ?? []),
    ...(data.videoReferences ?? []).map(reference => reference.url)];
  for (const source of sources) {
    if (source === undefined) continue;
    if (typeof source !== 'string' || source.startsWith('blob:') || /(?:^|\/)api\/canvas-preview(?:\?|$)/.test(source)) {
      throw new Error('请先保存原始素材，临时链接和预览图不能作为历史素材');
    }
  }
}
