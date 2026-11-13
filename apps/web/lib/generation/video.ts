import type { GenerationReference } from './types';

export const videoResolutions = ['480p', '720p', '1080p'] as const;
export type VideoResolution = typeof videoResolutions[number];
export const videoRatios = ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'] as const;

/** Presets use the short edge; ties round upward consistently in browser and server. */
export function videoDimensions(resolution: VideoResolution, ratio: string) {
  const short = Number.parseInt(resolution, 10);
  const [w, h] = ratio.split(':').map(Number);
  const width = short * Math.max(1, w / h);
  const height = short * Math.max(1, h / w);
  return { width: Math.round(width / 32) * 32, height: Math.round(height / 32) * 32 };
}
export function videoFrameCount(seconds: number): number {
  const frames = Math.max(5, Math.round(seconds * 24));
  return frames + (5 - frames % 17 + 17) % 17;
}
export function videoDuration(seconds: number): number { return videoFrameCount(seconds) / 24; }

export interface VideoReference extends GenerationReference {
  id: string; name: string; sourceNodeId?: string; hasAudio?: boolean;
}

/** The model presents images, then videos and their soundtracks, then standalone audio. */
export function referenceLabels(references: GenerationReference[]): string[] {
  let images = 0; let videos = 0; let audios = 0;
  const labels = new Array<string>(references.length);
  references.forEach((r, i) => { if (r.kind === 'image') labels[i] = `<Picture ${++images}>`; });
  references.forEach((r, i) => {
    if (r.kind === 'video') labels[i] = `<Video ${++videos}>` + (r.useAudio ? ` · <Audio ${++audios}>` : '');
  });
  references.forEach((r, i) => { if (r.kind === 'audio') labels[i] = `<Audio ${++audios}>`; });
  return labels;
}

export function orderReferences(uploads: VideoReference[], connected: VideoReference[], order: string[]): VideoReference[] {
  const available = new Map([...uploads, ...connected].map(r => [r.id, r]));
  const result: VideoReference[] = [];
  for (const id of order) { const ref = available.get(id); if (ref) { result.push(ref); available.delete(id); } }
  return [...result, ...available.values()];
}

export function remapReferenceIds(order: string[] | undefined, audio: Record<string, boolean> | undefined, ids: Map<string, string>) {
  const remap = (id: string) => id.startsWith('node:') ? `node:${ids.get(id.slice(5)) || id.slice(5)}` : id;
  return {
    ...(order ? { videoReferenceOrder: order.map(remap) } : {}),
    ...(audio ? { videoReferenceAudio: Object.fromEntries(Object.entries(audio).map(([id, enabled]) => [remap(id), enabled])) } : {}),
  };
}
