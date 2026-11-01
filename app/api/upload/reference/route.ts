import { NextRequest, NextResponse } from 'next/server';
import { getOSSClient } from '@/services/ossService';
import { inspectReference, referenceFileKind, referenceFileLimit } from '@/lib/generation/reference-files';

export const runtime = 'nodejs';
export async function POST(request: NextRequest) {
  try {
    if (Number(request.headers.get('content-length')) > referenceFileLimit + 64 * 1024)
      return NextResponse.json({ error: '参考素材不能超过 30 MB' }, { status: 413 });
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return NextResponse.json({ error: '请选择参考素材' }, { status: 400 });
    const kind = referenceFileKind(file.name);
    if (!kind || file.size > referenceFileLimit || !file.size)
      return NextResponse.json({ error: '请选择支持格式的图片、视频或音频，单个文件不超过 30 MB' }, { status: 400 });
    const buffer = Buffer.from(await file.arrayBuffer());
    let metadata;
    try { metadata = await inspectReference(buffer, file.name, kind); }
    catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : '素材校验失败' }, { status: 400 }); }
    const extension = file.name.split('.').pop()!.toLowerCase();
    const mime: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
      mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo', mkv: 'video/x-matroska',
      mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac' };
    const oss = getOSSClient();
    const objectKey = oss.generateObjectKey('references', 'reference.' + extension);
    await oss.uploadObject(objectKey, buffer, { 'Content-Type': mime[extension] });
    return NextResponse.json({ kind, url: oss.getPublicUrl(objectKey), name: file.name, ...metadata });
  } catch {
    return NextResponse.json({ error: '参考素材上传失败，请检查存储配置后重试' }, { status: 503 });
  }
}
