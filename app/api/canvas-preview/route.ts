import { canvasPreviewCache, previewLimits } from '@/lib/canvas-preview/server';

export const runtime = 'nodejs';

async function respond(source: string, request: Request) {
  try {
    const result = await canvasPreviewCache.get(source);
    const headers = { 'Content-Type': 'image/webp', 'Cache-Control': 'private, no-cache', ETag: result.etag, 'X-Content-Type-Options': 'nosniff' };
    if (request.headers.get('if-none-match') === result.etag) return new Response(null, { status: 304, headers });
    return new Response(new Uint8Array(result.bytes), { headers });
  } catch {
    return Response.json({ error: '画布预览不可用，请重试或主动查看原图' }, { status: 422, headers: { 'Cache-Control': 'no-store' } });
  }
}

export async function GET(request: Request) {
  return respond(new URL(request.url).searchParams.get('src') || '', request);
}

// Inline images in older projects exceed URL limits. Bound the body before parsing.
export async function POST(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return new Response(null, { status: 400 });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > Math.ceil(previewLimits.bytes * 4 / 3) + 128) return new Response(null, { status: 413 });
      chunks.push(value);
    }
    return respond(Buffer.concat(chunks).toString('utf8'), request);
  } finally { await reader.cancel(); }
}
