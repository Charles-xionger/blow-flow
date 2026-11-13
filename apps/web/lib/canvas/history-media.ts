import type { CanvasHistory } from './history';

const prefix = 'canvas-history-media:';
const packed = new WeakSet<object>();

/** Inline legacy originals are retained once per history, never converted to preview URLs. */
export function packHistoryMedia(history: CanvasHistory): CanvasHistory {
  if (packed.has(history)) return history;
  const assets = { ...history.assets };
  const ids = new Map(Object.entries(assets).map(([id, value]) => [value, id]));
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string' && /^data:(image|video|audio)\//.test(value)) {
      let id = ids.get(value);
      if (!id) { id = crypto.randomUUID(); ids.set(value, id); assets[id] = value; }
      return prefix + id;
    }
    if (!value || typeof value !== 'object' || packed.has(value)) return value;
    const entries = Object.entries(value).map(([key, child]) => [key, visit(child)] as const);
    const unchanged = entries.every(([key, child]) => child === (value as Record<string, unknown>)[key]);
    const result = unchanged ? value : Array.isArray(value) ? entries.map(([, child]) => child) : Object.fromEntries(entries);
    packed.add(result);
    return result;
  };
  const { assets: ignored, ...body } = history;
  void ignored;
  const result = { ...(visit(body) as CanvasHistory), ...(Object.keys(assets).length ? { assets } : {}) };
  packed.add(result);
  return result;
}

export function resolveHistoryMedia<T>(value: T, assets: CanvasHistory['assets']): T {
  if (!assets) return value;
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string' && item.startsWith(prefix)) {
      const original = assets?.[item.slice(prefix.length)];
      if (typeof original !== 'string') throw new Error('历史中的原始素材记录缺失');
      return original;
    }
    if (!item || typeof item !== 'object') return item;
    if (Array.isArray(item)) return item.map(visit);
    return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)]));
  };
  return visit(value) as T;
}
