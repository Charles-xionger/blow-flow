import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { referenceOrigin, readReferenceBody } from '../generation/reference-files';
import { mediaUploadLimit } from '../upload-limits';

const spec = 'webp-first-frame-1024-v1';
export const previewLimits = { bytes: mediaUploadLimit, pixels: 80_000_000, concurrency: 2, pending: 32, cacheBytes: 64 * 1024 * 1024, entries: 256, pendingBytes: 128 * 1024 * 1024 };
export const maxPreviewSourceLength = Math.ceil(previewLimits.bytes * 4 / 3) + 128;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export type Preview = { bytes: Buffer; etag: string; cache: 'hit' | 'generated'; stale?: boolean };
type Entry = Preview & { sourceEtag?: string; modified?: string };

/** Only the application's public OSS origin is fetched. No credentials, redirects,
 * local paths or arbitrary provider URLs. Legacy inline raster images need no network. */
function validateSource(source: string) {
  if (source.length > maxPreviewSourceLength) throw new Error('图片超过预览大小限制');
  if (/^data:image\/(png|jpeg|jpg|webp|gif|avif);base64,[a-zA-Z0-9+/=\r\n]+$/.test(source)) return;
  if (source.length > 4096) throw new Error("无效的图片地址");
  const url = new URL(source);
  const origin = referenceOrigin();
  if (!origin || !/^https:\/\/[a-z0-9-]+\.oss-[a-z0-9-]+\.aliyuncs\.com$/.test(origin)
    || url.origin !== origin || url.username || url.password || url.hash || url.search || url.pathname === '/')
    throw new Error('此来源暂不支持画布预览，请主动查看原图');
}

/** Process-local, disposable LRU. Remote validators are checked on every request;
 * sources without validators are downloaded again and keyed by their content digest. */
export function createPreviewCache(options: { fetch?: typeof fetch; cacheBytes?: number } = {}) {
  const fetchSource = options.fetch ?? fetch;
  const capacity = options.cacheBytes ?? previewLimits.cacheBytes;
  const entries = new Map<string, Entry>();
  const inflight = new Map<string, Promise<Preview>>();
  const queue: (() => void)[] = [];
  let active = 0;
  let size = 0;
  let pendingBytes = 0;
  function discard(key: string) {
    const previous = entries.get(key);
    if (previous) size -= previous.bytes.length;
    entries.delete(key);
  }
  function put(key: string, entry: Entry) {
    discard(key);
    if (entry.bytes.length <= capacity) { entries.set(key, entry); size += entry.bytes.length; }
    while (size > capacity || entries.size > previewLimits.entries) {
      const oldest = entries.keys().next().value!;
      size -= entries.get(oldest)!.bytes.length;
      entries.delete(oldest);
    }
  }
  async function generate(source: string, key: string): Promise<Preview> {
    if (active >= previewLimits.concurrency) await new Promise<void>(resolve => queue.push(resolve));
    else active++;
    const previous = entries.get(key);
    let fallback = previous;
    try {
      let bytes: Buffer;
      let sourceEtag: string | undefined;
      let modified: string | undefined;
      if (source.startsWith('data:')) {
        if (previous) { put(key, previous); return { ...previous, cache: 'hit' }; }
        bytes = Buffer.from(source.slice(source.indexOf(',') + 1), 'base64');
      } else {
        const headers: Record<string, string> = {};
        if (previous?.sourceEtag) headers['If-None-Match'] = previous.sourceEtag;
        else if (previous?.modified) headers['If-Modified-Since'] = previous.modified;
        const response = await fetchSource(source, { headers, redirect: 'error', signal: AbortSignal.timeout(15_000), cache: 'no-store' });
        if (response.status === 304 && previous) { put(key, previous); return { ...previous, cache: 'hit' }; }
        sourceEtag = response.headers.get('etag') || undefined;
        modified = response.headers.get('last-modified') || undefined;
        if (response.ok && previous && ((sourceEtag && previous.sourceEtag && sourceEtag !== previous.sourceEtag)
          || (!sourceEtag && modified && previous.modified && modified !== previous.modified))) {
          discard(key); fallback = undefined;
        }
        bytes = await readReferenceBody(response);
      }
      if (!bytes.length || bytes.length > previewLimits.bytes) throw new Error('图片超过预览大小限制');
      const etag = `"${hash(spec + hash(bytes))}"`;
      if (previous?.etag === etag) { const entry = { ...previous, sourceEtag, modified }; put(key, entry); return { ...entry, cache: 'hit' }; }
      // A new content digest confirms replacement even without remote validators.
      discard(key); fallback = undefined;
      const input = sharp(bytes, { pages: 1, page: 0, limitInputPixels: previewLimits.pixels, failOn: 'warning' });
      const metadata = await input.metadata();
      if (!['png', 'jpeg', 'webp', 'gif', 'avif', 'heif'].includes(metadata.format || '')) throw new Error('不支持的预览格式');
      const output = await input.rotate().resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 }).timeout({ seconds: 10 }).toBuffer();
      const entry: Entry = { bytes: output, etag, sourceEtag, modified, cache: 'generated' };
      put(key, entry);
      return entry;
    } catch (error) {
      // An unavailable origin does not erase an already usable preview. Confirmed
      // replacements above discard it before decoding, so old material cannot leak.
      if (fallback) return { ...fallback, stale: true };
      throw error;
    } finally {
      const next = queue.shift();
      if (next) next(); else active--;
    }
  }
  return {
    get(source: string): Promise<Preview> {
      try { validateSource(source); } catch (error) { return Promise.reject(error); }
      const key = hash(spec + source);
      const pending = inflight.get(key);
      if (pending) return pending;
      if (inflight.size >= previewLimits.pending || pendingBytes + source.length * 2 > previewLimits.pendingBytes) return Promise.reject(new Error('预览服务繁忙，请重试'));
      pendingBytes += source.length * 2;
      const result = generate(source, key).finally(() => { inflight.delete(key); pendingBytes -= source.length * 2; });
      inflight.set(key, result);
      return result;
    },
    clear() { entries.clear(); size = 0; },
  };
}

export const canvasPreviewCache = createPreviewCache();
