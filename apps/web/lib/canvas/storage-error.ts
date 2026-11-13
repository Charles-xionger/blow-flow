export type CanvasStorageFailure = 'unavailable' | 'quota' | 'aborted' | 'blocked' | 'transaction';

const messages: Record<CanvasStorageFailure, string> = {
  unavailable: '浏览器无法打开本地存储。请检查浏览器的存储权限或可用空间后重试。',
  quota: '本地存储空间不足。请释放设备或浏览器存储空间后重试。',
  aborted: '本地保存事务已中止，原有草稿仍保留。请重试保存。',
  blocked: '本地数据库升级被其他标签页阻塞。请关闭其他打开此应用的标签页后重试。',
  transaction: '本地存储读写失败，原有草稿仍保留。请重试。',
};

export class CanvasStorageError extends Error {
  constructor(readonly kind: CanvasStorageFailure, cause?: unknown) {
    super(messages[kind], { cause });
    this.name = 'CanvasStorageError';
  }
}

export function canvasStorageError(error: unknown, fallback: CanvasStorageFailure): CanvasStorageError {
  if (error instanceof CanvasStorageError) return error;
  const name = error instanceof Error ? error.name : '';
  const kind = name === 'QuotaExceededError' ? 'quota'
    : name === 'AbortError' ? 'aborted'
    : name === 'SecurityError' || name === 'NotSupportedError' ? 'unavailable'
    : fallback;
  return new CanvasStorageError(kind, error);
}
