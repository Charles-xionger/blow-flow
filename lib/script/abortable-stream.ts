/** A provider that ignores abort cannot retain an executor slot or deliver late deltas. */
export async function* abortableStream(source: AsyncIterable<string>, signal: AbortSignal) {
  const iterator = source[Symbol.asyncIterator]();
  let rejectAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const next = await Promise.race([iterator.next(), aborted]);
      if (next.done) return;
      signal.throwIfAborted();
      yield next.value;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    // Do not await a stuck adapter's return; the lease/status fence owns writes.
    void iterator.return?.().catch(() => {});
  }
}
