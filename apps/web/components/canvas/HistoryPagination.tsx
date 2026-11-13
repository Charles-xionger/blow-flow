export const pageSize = 20;
export const actionNames = { edit: '编辑', undo: '撤销', redo: '重做', boundary: '外部内容变更', noop: '无内容变化' };
export const buttonClass = 'rounded border border-zinc-400/30 px-3 py-1 text-sm hover:bg-zinc-500/10 disabled:opacity-30';
export function Time({ value }: { value?: number }) {
  return value === undefined ? <span>时间未知（旧记录）</span> : <time dateTime={new Date(value).toISOString()}>{new Date(value).toLocaleString('zh-CN')}</time>;
}
export function Pages({ page, total, setPage, name }: { page: number; total: number; setPage: (page: number) => void; name: string }) {
  return <nav aria-label={`${name}分页`} className="my-3 flex items-center justify-between gap-3">
    <button className={buttonClass} disabled={page === 0} onClick={() => setPage(page - 1)} aria-label={`上一页${name}`}>上一页</button>
    <span className="text-xs">{page + 1} / {Math.max(1, Math.ceil(total / pageSize))} · 共 {total} 条</span>
    <button className={buttonClass} disabled={(page + 1) * pageSize >= total} onClick={() => setPage(page + 1)} aria-label={`下一页${name}`}>下一页</button>
  </nav>;
}
