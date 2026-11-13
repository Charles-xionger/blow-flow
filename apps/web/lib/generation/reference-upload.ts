import type { TaskSnapshot } from './service';
import type { GenerationReference } from './types';
import type { UploadedReference } from './video-workflow';
import { inspectReference, readReferenceBody, referenceFileKind, validReferenceUrl } from './reference-files';

// Media transfers have a different budget from small create/status requests.
// Renew before download+probe and before upload, with room for each bounded step.
export const referenceTransferTiming = { downloadTimeoutMs: 60_000, uploadTimeoutMs: 180_000, leaseMarginMs: 45_000 } as const;
export function referencePreparationLeaseMs(requestTimeoutMs: number) {
  return Math.max(requestTimeoutMs, referenceTransferTiming.downloadTimeoutMs, referenceTransferTiming.uploadTimeoutMs)
    + referenceTransferTiming.leaseMarginMs;
}
type PreparationStage = 'download' | 'inspect' | 'upload';
export class ReferencePreparationError extends Error {
  constructor(message: string, readonly diagnostic?: { stage: string; index: number; kind: string; reason: string; httpStatus?: number; platformCode?: number }) {
    super(message);
  }
}

/** Asset uploads cannot create a paid generation; failures are safe to retry as a new request. */
export async function uploadReferences(snapshot: TaskSnapshot, references: GenerationReference[], fetcher: typeof fetch,
  renew: () => boolean, inspect = inspectReference): Promise<UploadedReference[]> {
  const uploaded: UploadedReference[] = [];
  for (const [index, reference] of references.entries()) {
    if (!renew()) throw new ReferencePreparationError('素材准备已由其他进程接管');
    let stage: PreparationStage = 'download';
    let httpStatus: number | undefined;
    let platformCode: number | undefined;
    try {
      if (!validReferenceUrl(reference.url)) throw new Error('参考素材不在本项目存储中');
      const filename = new URL(reference.url).pathname.split('/').pop()!;
      if (referenceFileKind(filename) !== reference.kind) throw new Error('参考素材格式与类型不符');
      const download = await fetcher(reference.url, { redirect: 'error', signal: AbortSignal.timeout(referenceTransferTiming.downloadTimeoutMs) });
      httpStatus = download.status;
      const bytes = await readReferenceBody(download);
      stage = 'inspect'; httpStatus = undefined;
      const metadata = await inspect(bytes, filename, reference.kind);
      if (reference.kind === 'video' && reference.useAudio && !metadata.hasAudio)
        throw new Error('参考视频没有音轨，请关闭该素材的原声开关');
      if (!renew()) throw new ReferencePreparationError('素材准备已由其他进程接管');
      const key = process.env[snapshot.connection.apiKeyEnv];
      if (!key) throw new Error('平台连接未配置');
      const form = new FormData();
      form.set('apiKey', key); form.set('fileType', 'input');
      form.set('file', new Blob([new Uint8Array(bytes)]), filename);
      stage = 'upload';
      const response = await fetcher(`${snapshot.connection.baseUrl.replace(/\/$/, '')}/task/openapi/upload`, {
        method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form,
        redirect: 'error', signal: AbortSignal.timeout(referenceTransferTiming.uploadTimeoutMs),
      });
      httpStatus = response.status;
      if (!response.ok) throw new Error('平台素材上传失败');
      const result = await response.json();
      platformCode = typeof result.code === 'number' ? result.code : undefined;
      if (result.code !== 0 || typeof result.data?.fileName !== 'string' || !result.data.fileName)
        throw new Error('平台未返回有效的素材文件名');
      uploaded.push({ ...reference, fileName: result.data.fileName, ...('duration' in metadata ? { duration: metadata.duration } : {}) });
    } catch (error) {
      // Do not expose platform replies, signed URLs or SDK diagnostics to clients.
      if (error instanceof ReferencePreparationError) throw error;
      const timedOut = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name);
      const label = { download: '参考素材下载', inspect: '参考素材校验', upload: '平台素材上传' }[stage];
      const safe = error instanceof Error && [
        '参考素材不在本项目存储中', '参考素材格式与类型不符', '参考视频没有音轨，请关闭该素材的原声开关',
        '参考视频须为约 0.21–15 秒，请先选取片段后上传', '参考素材不能超过 30 MB',
        '服务端未安装 ffprobe，暂时无法校验参考素材', '无法解码参考素材，请检查格式或重新导出',
        '素材内容与文件类型不符', '参考素材为空', '平台连接未配置',
      ].includes(error.message) ? error.message : timedOut ? `${label}超时，请稍后重试`
        : httpStatus && httpStatus >= 400 ? `${label}失败（HTTP ${httpStatus}）`
        : platformCode !== undefined && platformCode !== 0 ? `${label}被拒绝（错误码 ${platformCode}）` : `${label}失败`;
      throw new ReferencePreparationError(safe, { stage: `reference_${stage}`, index, kind: reference.kind,
        reason: timedOut ? 'timeout' : 'failed', ...(httpStatus !== undefined ? { httpStatus } : {}),
        ...(platformCode !== undefined ? { platformCode } : {}) });
    }
  }
  return uploaded;
}
