"use client";

import { memo, useCallback, useState } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { Handle, Position } from "@xyflow/react";
import { useCanvasStore } from "@/store/useCanvasStore";
import {
  Sparkles,
  Copy,
  CheckCircle,
  FileText,
  Loader2,
  Wand2,
} from "lucide-react";
import type { NodeData } from "@/types";
import { EditableTitle } from "./shared/EditableTitle";
import { QuickAddNode } from "../canvas/QuickAddNode";

const CreativeDescNode = ({
  id,
  data,
  selected,
}: NodeProps<Node<NodeData>>) => {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const nodes = useCanvasStore((state) => state.nodes);
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds);
  const currentNode = nodes.find((n) => n.id === id);
  const nodePosition = currentNode?.position || { x: 0, y: 0 };
  const [copied, setCopied] = useState(false);

  // 只有在单选状态下才显示控制面板
  const shouldShowPanel = selected && selectedNodeIds.length === 1;

  const handleOptimize = useCallback(async () => {
    if (!data.prompt) return;

    updateNodeData(id, { isLoading: true, error: undefined });

    try {
      const response = await fetch("/api/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: data.prompt,
        }),
      });

      const result = await response.json();

      if (result.success && result.data) {
        updateNodeData(id, {
          isLoading: false,
          optimizedPrompt: result.data,
        });
      } else {
        throw new Error(result.error || "优化失败");
      }
    } catch (error) {
      updateNodeData(id, {
        isLoading: false,
        error: error instanceof Error ? error.message : "优化失败",
      });
    }
  }, [id, data.prompt, updateNodeData]);

  const handleCopy = useCallback(() => {
    if (data.optimizedPrompt) {
      navigator.clipboard.writeText(data.optimizedPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [data.optimizedPrompt]);

  const hasResult = !!data.optimizedPrompt && !data.isLoading;

  return (
    <>
      {/* 可编辑标题 */}
      <EditableTitle
        nodeId={id}
        defaultTitle={data.label}
        customTitle={data.customTitle}
      />

      {/* 输出句柄 */}
      <div className="absolute right-0 top-1/2 -translate-y-1/2 flex items-center">
        <QuickAddNode nodeId={id} nodePosition={nodePosition} />
        <Handle type="source" position={Position.Right} id="output" />
      </div>

      {/* 节点显示区域 */}
      <div
        style={{ width: "320px", height: "240px" }}
        className={`relative rounded-2xl border ${
          selected
            ? "border-cyan-500 ring-2 ring-cyan-500/30"
            : "border-zinc-700/50"
        } bg-[#1a1a1a] overflow-hidden shadow-xl group transition-all duration-200`}
      >
        {hasResult ? (
          <div className="relative w-full h-full p-4 overflow-y-auto">
            <div className="text-xs text-zinc-400 mb-2 flex items-center gap-2">
              <Sparkles size={12} className="text-cyan-400" />
              <span>优化后的提示词</span>
            </div>
            <p className="text-sm text-zinc-200 leading-relaxed whitespace-pre-wrap wrap-break-word">
              {data.optimizedPrompt}
            </p>
          </div>
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-zinc-500">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4 bg-zinc-800/50 text-zinc-500">
              <FileText size={28} className="opacity-60" />
            </div>
            <span className="text-sm font-medium opacity-60">提示词优化</span>
            <span className="text-xs opacity-40 mt-1">选中节点开始优化</span>
          </div>
        )}

        {data.isLoading && (
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex flex-col items-center justify-center z-20">
            <Loader2 size={32} className="text-cyan-500 animate-spin mb-3" />
            <span className="text-white/80 text-sm font-medium">优化中...</span>
          </div>
        )}
      </div>

      {/* 控制面板 */}
      {shouldShowPanel && (
        <div
          className="absolute top-full left-1/2 -translate-x-1/2 min-w-100 pt-4 z-70 pointer-events-auto"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="bg-[#1a1a1a]/95 backdrop-blur-xl border border-zinc-700/50 rounded-2xl p-4 flex flex-col gap-3">
            <textarea
              className="nodrag w-full border rounded-xl px-4 py-3 text-sm leading-relaxed resize-none focus:outline-none focus:ring-2 focus:ring-cyan-500/20 min-h-18 bg-zinc-800/80 hover:bg-zinc-800 border-zinc-700 focus:border-cyan-500 text-white placeholder-zinc-500 transition-all"
              placeholder="输入简单的描述，AI 会帮你扩展成专业提示词..."
              value={data.prompt || ""}
              onChange={(e) => updateNodeData(id, { prompt: e.target.value })}
              onWheel={(e) => e.stopPropagation()}
              rows={3}
            />

            <div className="flex items-center gap-2">
              <button
                onClick={handleOptimize}
                disabled={data.isLoading || !data.prompt}
                className={`flex-1 h-10 px-4 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 whitespace-nowrap transition-all active:scale-[0.98] ${
                  data.isLoading || !data.prompt
                    ? "bg-gray-400 text-white cursor-not-allowed"
                    : "bg-linear-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 text-white shadow-lg shadow-cyan-500/25 hover:shadow-cyan-500/40"
                }`}
              >
                {data.isLoading ? (
                  <Loader2 className="animate-spin" size={15} />
                ) : (
                  <Wand2 size={15} />
                )}
                <span>{data.isLoading ? "优化中" : "AI 优化"}</span>
              </button>

              {data.optimizedPrompt && (
                <button
                  onClick={handleCopy}
                  className="shrink-0 h-10 px-4 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 border border-zinc-700 text-white hover:bg-zinc-800 transition-all"
                >
                  {copied ? (
                    <>
                      <CheckCircle size={15} />
                      已复制
                    </>
                  ) : (
                    <>
                      <Copy size={15} />
                      复制
                    </>
                  )}
                </button>
              )}
            </div>

            {data.optimizedPrompt && (
              <div>
                <label className="text-xs font-medium text-zinc-400 mb-2 block">
                  编辑优化后的提示词
                </label>
                <textarea
                  value={data.optimizedPrompt}
                  onChange={(e) =>
                    updateNodeData(id, { optimizedPrompt: e.target.value })
                  }
                  className="nodrag w-full border rounded-xl px-4 py-3 text-sm leading-relaxed resize-none focus:outline-none focus:ring-2 focus:ring-cyan-500/20 min-h-30 bg-zinc-800/80 hover:bg-zinc-800 border-zinc-700 focus:border-cyan-500 text-white placeholder-zinc-500 transition-all"
                  onWheel={(e) => e.stopPropagation()}
                />
                <p className="text-xs text-zinc-500 mt-2">
                  提示：你可以继续编辑优化后的提示词
                </p>
              </div>
            )}

            {data.error && (
              <div className="text-xs text-red-400 bg-red-500/10 px-3 py-2 rounded-lg border border-red-500/20">
                {data.error}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
};

CreativeDescNode.displayName = "CreativeDescNode";

export default memo(CreativeDescNode);
