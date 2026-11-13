"use client";

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { HistoryPage } from '@/lib/canvas/history-page';
import { actionNames, buttonClass, Time, Pages } from './HistoryPagination';

type Selection = { batch?: string; label?: string; operation?: string };
export default function RemoteHistory({ project }: { project: string }) {
  const [selection, setSelection] = useState<Selection>({});
  const [page, setPage] = useState(0);
  const [retry, setRetry] = useState(0);
  const version = useRef<number | undefined>(undefined);
  const key = JSON.stringify([project, selection, page, retry]);
  const [response, setResponse] = useState<{ key: string; data?: HistoryPage; error?: string }>();
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ page: String(page) });
    if (selection.batch) query.set('batch', selection.batch);
    if (selection.operation) query.set('operation', selection.operation);
    if (version.current !== undefined) query.set('version', String(version.current));
    void fetch(`/api/workflow/${encodeURIComponent(project)}/history?${query}`, { signal: controller.signal, cache: 'no-store' })
      .then(async result => {
        const data = await result.json();
        if (!result.ok) throw new Error(data.error || '历史读取失败');
        if (controller.signal.aborted) return;
        version.current = data.version;
        setResponse({ key, data });
      }).catch(error => { if (!controller.signal.aborted) setResponse({ key, error: error instanceof Error ? error.message : '历史读取失败' }); });
    return () => controller.abort();
  }, [project, selection, page, retry, key]);
  const data = response?.key === key ? response.data : undefined;
  const error = response?.key === key ? response.error : undefined;
  const select = (next: Selection) => { setSelection(next); setPage(0); };
  const name = selection.operation ? '受影响内容' : selection.batch ? '内部操作' : '批次';
  return <main className="mx-auto min-h-screen max-w-3xl bg-white p-8 text-zinc-900">
    <nav className="mb-6 flex gap-6"><Link href="/workspace">返回工作空间</Link><Link href={`/canvas?project=${encodeURIComponent(project)}`} prefetch={false}>打开画布</Link></nav>
    <h1 className="text-xl font-semibold">服务端操作历史</h1>
    <p className="my-2">{data?.name}</p>
    <p className="text-sm text-zinc-500">这里只显示服务端已保存记录，不包含设备上尚未同步的编辑。查看当前本地内容与保存状态，请打开画布。失效分支仅供追溯。</p>
    {selection.batch && <div className="my-4 flex gap-3"><button className={buttonClass} onClick={() => select({})}>返回批次</button>
      {selection.operation && <button className={buttonClass} onClick={() => select({ batch: selection.batch, label: selection.label })}>返回内部操作</button>}
      <span>{selection.label}</span></div>}
    {error ? <div role="alert" className="py-8"><p>{error}</p><button className={buttonClass} onClick={() => {
      version.current = undefined; select({}); setRetry(retry + 1);
    }}>重新加载历史</button></div> : !data ? <p role="status" className="py-8">正在读取历史…</p> : <>
      <p className="mt-4 text-sm">服务端已保存 · 版本 {data.version}</p>
      <Pages page={page} total={data.total} setPage={setPage} name={name} />
      {data.total === 0 && <p>暂无{name}记录。</p>}
      <ul className="space-y-3">
        {data.batches?.map(batch => <li key={batch.id} data-testid="remote-history-batch" className="rounded-lg border p-3">
          <p><strong>{batch.label}</strong> · {batch.status}</p><p className="text-xs text-zinc-500"><Time value={batch.time} /> · 批次 {batch.id}</p>
          <button className={`${buttonClass} mt-2`} aria-label={`查看批次 ${batch.label}`} onClick={() => select({ batch: batch.id, label: batch.label })}>查看批次详情（{batch.operationCount} 次内部操作）</button>
        </li>)}
        {data.operations?.map(op => <li key={op.id} className="rounded-lg border p-3"><p>{actionNames[op.kind]} · <Time value={op.time} /></p>
          <button className={`${buttonClass} mt-2`} onClick={() => select({ ...selection, operation: op.id })}>查看受影响内容</button><span className="ml-2 text-sm">{op.detailCount} 项</span></li>)}
        {data.details?.map((detail, i) => <li key={i} className="rounded-lg border p-3">{detail}</li>)}
      </ul>
    </>}
  </main>;
}
