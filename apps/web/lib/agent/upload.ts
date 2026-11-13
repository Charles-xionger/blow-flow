import type { AgentReference } from './types';

/** Preserve the original file in the same asset storage used by canvas images. */
export async function uploadAgentReference(file: File): Promise<AgentReference> {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10_000_000)
        throw new Error('请选择不超过 10 MB 的 PNG、JPEG 或 WebP 图片。');
    const body = new FormData(); body.append('file', file);
    const response = await fetch('/api/upload/image', {method:'POST',body});
    const result = await response.json();
    if (!response.ok || !result.success || typeof result.data?.url !== 'string' || typeof result.data?.objectKey !== 'string')
        throw new Error(result.error || '参考图上传失败，请重试。');
    return {url:result.data.url,assetId:result.data.objectKey,name:file.name,mimeType:file.type};
}
