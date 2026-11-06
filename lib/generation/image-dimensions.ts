import { validGenerationDimensions } from './dimensions';
import type { PublicModel } from './types';

export type ImageDimensions = { width: number; height: number };
export type DimensionLimits = PublicModel['capabilities']['dimensions'];
export type ImageSizePreset = '1k' | '1.5k' | '2k' | 'custom';
export const imageAspectRatios = ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '4:5', '5:4', '21:9'] as const;
export type ImageAspectRatio = typeof imageAspectRatios[number];

/** Product presets, not model quality levels. Never clamp a preset into a different aspect ratio. */
export function imagePresetDimensions(preset: Exclude<ImageSizePreset, 'custom'>, ratio: ImageAspectRatio, limits: DimensionLimits): ImageDimensions | null {
  if (preset === '1.5k') return null;
  const [w, h] = ratio.split(':').map(Number);
  const shortEdge = preset === '1k' ? 1024 : 2048;
  const align = (value: number) => Math.round(value / limits.step) * limits.step;
  const width = align(shortEdge * w / Math.min(w, h));
  const height = align(shortEdge * h / Math.min(w, h));
  return validGenerationDimensions(limits, width, height) ? { width, height } : null;
}

export function normalizeImageDimension(raw: string, previous: number, limits: DimensionLimits): number {
  if (!raw.trim() || !Number.isFinite(Number(raw))) return previous;
  const lower = Math.ceil(limits.min / limits.step) * limits.step;
  const upper = Math.floor(limits.max / limits.step) * limits.step;
  return Math.min(upper, Math.max(lower, Math.round(Number(raw) / limits.step) * limits.step));
}

/** Describe existing pixels without mutating them, including older canvases without preset metadata. */
export function imageSizeSelection(width: number, height: number, limits: DimensionLimits, preference?: ImageSizePreset): {
  preset: ImageSizePreset; ratio: ImageAspectRatio | null; label: string;
} {
  const ratio = imageAspectRatios.find(value => {
    const [w, h] = value.split(':').map(Number);
    return Math.abs(width - height * w / h) <= limits.step / 2
      || Math.abs(height - width * h / w) <= limits.step / 2;
  }) ?? null;
  const preset = preference === 'custom' ? 'custom' : (['1k', '2k'] as const).find(value => {
    const size = ratio && imagePresetDimensions(value, ratio, limits);
    return size && size.width === width && size.height === height;
  }) ?? 'custom';
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  const divisor = gcd(width, height) || 1;
  return { preset, ratio, label: ratio ?? `${width / divisor}:${height / divisor}` };
}
