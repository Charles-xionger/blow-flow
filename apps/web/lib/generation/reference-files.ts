import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ReferenceKind } from './types';
import { mediaUploadLimit } from '../upload-limits';

export const referenceFileLimit = mediaUploadLimit;
const formats: Record<ReferenceKind, string[]> = {
  image: ['jpg', 'jpeg', 'png', 'webp'], video: ['mp4', 'avi', 'mov', 'mkv'], audio: ['mp3', 'wav', 'flac'],
};
export function referenceFileKind(filename: string): ReferenceKind | undefined {
  const extension = filename.split('.').pop()?.toLowerCase() || '';
  return (Object.keys(formats) as ReferenceKind[]).find(kind => formats[kind].includes(extension));
}
export function referenceOrigin(): string | undefined {
  const { OSS_BUCKET_NAME: bucket, OSS_REGION: region } = process.env;
  return bucket && region ? `https://${bucket}.${region}.aliyuncs.com` : undefined;
}
export function validReferenceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === referenceOrigin() && !url.username && !url.password && !url.search && !url.hash && url.pathname !== '/';
  } catch { return false; }
}
export async function readReferenceBody(response: Response): Promise<Buffer> {
  if (!response.ok || !response.body) throw new Error('无法读取参考素材');
  const declared = Number(response.headers.get('content-length'));
  if (declared > referenceFileLimit) { await response.body.cancel(); throw new Error('参考素材不能超过 30 MB'); }
  const chunks: Uint8Array[] = []; let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > referenceFileLimit) throw new Error('参考素材不能超过 30 MB');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  if (!size) throw new Error('参考素材为空');
  return Buffer.concat(chunks);
}

/** Probe local bytes only: ffprobe never follows user-supplied remote addresses. */
export async function inspectReference(buffer: Buffer, filename: string, kind: ReferenceKind) {
  if (!buffer.length || buffer.length > referenceFileLimit) throw new Error('参考素材须为 1 字节至 30 MB');
  if (referenceFileKind(filename) !== kind) throw new Error('不支持的参考素材格式');
  const dir = await mkdtemp(join(tmpdir(), 'ai-flow-reference-'));
  try {
    const path = join(dir, 'input.' + filename.split('.').pop()!.toLowerCase());
    await writeFile(path, buffer);
    const { stdout } = await promisify(execFile)(process.env.FFPROBE_PATH || 'ffprobe',
      ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-show_format', '-of', 'json', path],
      { timeout: 15_000, maxBuffer: 256 * 1024 });
    const info = JSON.parse(stdout) as { streams?: { codec_type: string; codec_name?: string; duration?: string; width?: number; height?: number }[]; format?: { duration?: string; format_name?: string } };
    const hasAudio = !!info.streams?.some(s => s.codec_type === 'audio');
    const visual = info.streams?.find(s => s.codec_type === 'video');
    if ((kind === 'audio' && !hasAudio) || (kind !== 'audio' && !visual)) throw new Error('素材内容与文件类型不符');
    if (kind === 'image' && !['png', 'mjpeg', 'webp'].includes(visual?.codec_name || '')) throw new Error('素材内容与文件类型不符');
    if (kind === 'audio' && !info.format?.format_name?.split(',').some(format => ['mp3', 'wav', 'flac'].includes(format)))
      throw new Error('素材内容与文件类型不符');
    const duration = Number(kind === 'video' ? visual?.duration || info.format?.duration : info.format?.duration);
    if (kind === 'video' && (!Number.isFinite(duration) || duration < 5 / 24 || duration > 15.1))
      throw new Error('参考视频须为约 0.21–15 秒，请先选取片段后上传');
    const imageMetadata = kind === 'image' ? await (await import('sharp')).default(buffer).metadata() : undefined;
    return { hasAudio, ...(imageMetadata ? { hasAlpha: imageMetadata.hasAlpha } : {}), ...(Number.isFinite(duration) ? { duration } : {}) };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      throw new Error('服务端未安装 ffprobe，暂时无法校验参考素材');
    if (error instanceof Error && !('code' in error)) throw error;
    throw new Error('无法解码参考素材，请检查格式或重新导出');
  } finally { await rm(dir, { recursive: true, force: true }); }
}
