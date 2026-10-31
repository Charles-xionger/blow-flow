import OSS from 'ali-oss';

// OSS's scalar timeout applies separately to connection and response.
// 2*15s HEAD + 30s download + 2*60s PUT = 180s; retain a 60s lease margin.
export const artifactTransferTiming = {
  headTimeoutMs: 15_000, downloadTimeoutMs: 30_000, uploadTimeoutMs: 60_000, leaseMs: 240_000,
} as const;

type SaveFailure = 'unavailable' | 'download_timeout' | 'download' | 'upload' | 'storage_check' | 'configuration';
const failureLabels: Record<SaveFailure, string> = {
  unavailable: '平台临时结果已过期或无法取回',
  download_timeout: '结果下载超时',
  download: '结果下载失败',
  upload: 'OSS 上传失败或结果未确认',
  storage_check: '无法核实 OSS 中的已有产物',
  configuration: 'OSS 未配置',
};
export class ArtifactSaveError extends Error {
  constructor(readonly reason: SaveFailure) { super(failureLabels[reason]); }
}
interface StorageIO {
  fetch: typeof fetch;
  client: {
    head(key: string, options: OSS.HeadObjectOptions): Promise<unknown>;
    put(key: string, content: Buffer, options: OSS.PutObjectOptions): Promise<unknown>;
  };
  publicUrl(key: string): string;
}

// SDK/network dependencies are external boundaries; the same saver is used by the worker and recovery tests.
export function createGenerationImageSaver(io: StorageIO) {
  return async (url: string, taskId: string, index: number): Promise<string> => {
    const key = `images/generation/${taskId}/${index}.png`;
    // A previous process may have uploaded successfully before recording the URL.
    try {
      await io.client.head(key, { timeout: artifactTransferTiming.headTimeoutMs });
      return io.publicUrl(key);
    } catch (error) {
      if (!error || typeof error !== 'object' || !('status' in error) || error.status !== 404)
        throw new ArtifactSaveError('storage_check');
    }
    let content: Buffer;
    let contentType: string;
    try {
      const response = await io.fetch(url, { signal: AbortSignal.timeout(artifactTransferTiming.downloadTimeoutMs) });
      if ([403, 404, 410].includes(response.status)) throw new ArtifactSaveError('unavailable');
      if (!response.ok) throw new ArtifactSaveError('download');
      content = Buffer.from(await response.arrayBuffer());
      contentType = response.headers.get('content-type') || 'image/png';
    } catch (error) {
      if (error instanceof ArtifactSaveError) throw error;
      throw new ArtifactSaveError(error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
        ? 'download_timeout' : 'download');
    }
    try {
      await io.client.put(key, content, { timeout: artifactTransferTiming.uploadTimeoutMs, headers: { 'Content-Type': contentType } });
    } catch { throw new ArtifactSaveError('upload'); }
    return io.publicUrl(key);
  };
}

export async function saveGenerationImage(url: string, taskId: string, index: number): Promise<string> {
  const { OSS_REGION: region, OSS_ACCESS_KEY_ID: accessKeyId, OSS_ACCESS_KEY_SECRET: accessKeySecret, OSS_BUCKET_NAME: bucket } = process.env;
  if (!region || !accessKeyId || !accessKeySecret || !bucket) throw new ArtifactSaveError('configuration');
  const client = new OSS({ region, accessKeyId, accessKeySecret, bucket, timeout: artifactTransferTiming.uploadTimeoutMs });
  return createGenerationImageSaver({ fetch, client,
    publicUrl: key => `https://${bucket}.${region}.aliyuncs.com/${key}` })(url, taskId, index);
}
