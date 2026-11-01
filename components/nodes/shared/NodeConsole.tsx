"use client";

import type { ReactNode } from "react";
import { Loader2, Wand2 } from "lucide-react";
import type { NodeData } from "@/types";

/**
 * Connections, editor, then config and run; each layer is optional. Owns the run button and
 * the shared run area, so a node type only declares its controls and when it can run.
 */
export function NodeConsole({ data, connections, editor, config, onRun, runDisabled, notice, onResume, onRetrySave }: {
  data: NodeData;
  connections?: ReactNode;
  editor?: ReactNode;
  config?: ReactNode;
  onRun?: () => void;
  runDisabled?: boolean;
  notice?: string;
  onResume?: () => void;
  onRetrySave?: () => void;
}) {
  const blocked = data.isLoading || runDisabled;
  return (
    <section aria-label="节点控制台"
      className="nodrag nopan nowheel absolute left-1/2 top-full z-70 mt-3 flex w-[440px] -translate-x-1/2 cursor-auto select-text flex-col gap-2 rounded-[20px] border border-white/10 bg-[#1c1c1c] p-3 text-[13px] text-zinc-200 shadow-2xl">
      {connections}
      {editor}
      {(config || onRun) && (
        <div className="flex items-center gap-0.5">
          {config}
          <div className="flex-1" />
          {onRun && (
            <button type="button" onClick={onRun} disabled={blocked}
              className="flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-violet-600 px-3 text-xs font-semibold text-white transition-colors hover:bg-violet-500 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500">
              {data.isLoading ? <Loader2 className="animate-spin" size={14} /> : <Wand2 size={14} />}
              <span>{data.isLoading ? "生成中" : data.pendingGeneration ? "恢复原请求" : data.generationTaskId ? "重新生成" : "生成"}</span>
            </button>
          )}
        </div>
      )}
      {notice && <div className="text-[11px] text-zinc-500">{notice}</div>}
      {onResume && data.generationBlocked && data.generationTaskId && (
        <button type="button" onClick={onResume} className="text-sm text-blue-300">继续查询原任务</button>
      )}
      {onRetrySave && (data.generationCanRetrySave || data.generationSaving) && data.generationTaskId && (
        <button type="button" disabled={!data.generationCanRetrySave || data.generationSaving} onClick={onRetrySave}
          className="text-sm text-blue-300 disabled:opacity-50">
          {data.generationSaving ? "保存中…" : "重试保存（不重新生成）"}
        </button>
      )}
      {data.generationStatus && <div role="status" className="text-xs text-blue-300">{data.generationStatus}</div>}
      {data.error && (
        <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">{data.error}</div>
      )}
    </section>
  );
}
