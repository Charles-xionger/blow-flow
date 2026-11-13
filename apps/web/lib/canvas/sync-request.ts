export class CanvasRequestError extends Error {
  constructor(message: string, public blocked?: 'validation' | 'permanent', public retryAfter?: number, public status?: number) { super(message); }
}


// Bound both response headers and body consumption. Some transports keep a
// promise alive after abort; only the winner of this race reaches confirmation.
export async function canvasRequest(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(url, { ...init, signal: controller.signal });
        const result = await response.json().catch(() => null);
        if (!response.ok || !result?.success || !result.data) {
          const permanent = response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status);
          const validation = [400, 422].includes(response.status) && result?.success === false;
          const hint = response.headers.get('Retry-After');
          const seconds = hint === null || !hint.trim() ? NaN : Number(hint);
          const at = Number.isFinite(seconds) ? Date.now() + Math.max(0, seconds) * 1000 : Date.parse(hint || '');
          throw new CanvasRequestError(result?.error || `服务端保存失败 (${response.status})`,
            validation ? 'validation' : permanent ? 'permanent' : undefined,
            Number.isFinite(at) ? at : undefined, response.status);
        }
        return result.data;
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('请求超时，已保留原操作等待核实'));
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
