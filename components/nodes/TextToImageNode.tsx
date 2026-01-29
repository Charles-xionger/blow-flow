"use client";

import { memo, useCallback } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { Handle, Position } from "@xyflow/react";
import { useCanvasStore } from "@/store/useCanvasStore";
import { Image, Sparkles, Wand2, Loader2 } from "lucide-react";
import type { NodeData } from "@/types";

const imageModels = [
  { value: "BananaPro", label: "Banana Pro" },
  { value: "Banana", label: "Banana" },
  { value: "Flux2", label: "Flux 2" },
  { value: "即梦 4.5", label: "即梦 4.5" },
  { value: "MJ", label: "Midjourney" },
];

const aspectRatios = [
  { value: "1:1", label: "1:1 方形" },
  { value: "16:9", label: "16:9 横屏" },
  { value: "9:16", label: "9:16 竖屏" },
  { value: "4:3", label: "4:3 传统" },
  { value: "3:4", label: "3:4 竖版" },
];

const resolutions = [
  { value: "1k", label: "1K" },
  { value: "2k", label: "2K" },
  { value: "4k", label: "4K" },
];

const TextToImageNode = ({ id, data, selected }: NodeProps<Node<NodeData>>) => {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);

  const handleGenerate = useCallback(async () => {
    if (!data.prompt) return;

    updateNodeData(id, { isLoading: true, error: undefined });

    try {
      const response = await fetch("/api/generate/image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: data.prompt,
          model: data.model || "BananaPro",
          aspectRatio: data.aspectRatio || "1:1",
          resolution: data.resolution || "1k",
          count: data.count || 1,
          promptOptimize: data.promptOptimize || false,
        }),
      });

      const result = await response.json();

      if (result.success && result.data && result.data.length > 0) {
        updateNodeData(id, {
          isLoading: false,
          imageSrc: result.data[0],
          outputArtifacts: result.data,
        });
      } else {
        throw new Error(result.error || "生成失败");
      }
    } catch (error) {
      updateNodeData(id, {
        isLoading: false,
        error: error instanceof Error ? error.message : "生成失败",
      });
    }
  }, [
    id,
    data.prompt,
    data.model,
    data.aspectRatio,
    data.resolution,
    data.count,
    data.promptOptimize,
    updateNodeData,
  ]);

  const hasResult = !!data.imageSrc && !data.isLoading;

  return (
    <>
      {/* 输出句柄 */}
      <Handle type="source" position={Position.Right} id="output" />

      {/* 节点显示区域 */}
      <div
        style={{ width: "320px", height: "240px" }}
        className={`relative rounded-2xl border ${
          selected
            ? "border-blue-500 ring-2 ring-blue-500/30"
            : "border-zinc-700/50"
        } bg-[#1a1a1a] overflow-hidden shadow-xl group transition-all duration-200`}
      >
        {hasResult ? (
          <div className="relative w-full h-full">
            <img
              src={data.imageSrc}
              alt="Generated"
              className="w-full h-full object-contain"
            />
          </div>
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-zinc-500">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4 bg-zinc-800/50 text-zinc-500">
              <Image size={28} className="opacity-60" />
            </div>
            <span className="text-sm font-medium opacity-60">生图</span>
            <span className="text-xs opacity-40 mt-1">选中节点开始创作</span>
          </div>
        )}

        {data.isLoading && (
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex flex-col items-center justify-center z-20">
            <Loader2 size={32} className="text-blue-500 animate-spin mb-3" />
            <span className="text-white/80 text-sm font-medium">生成中...</span>
          </div>
        )}
      </div>

      {/* 控制面板 */}
      {selected && (
        <div
          className="absolute top-full left-1/2 -translate-x-1/2 min-w-[400px] pt-4 z-[70] pointer-events-auto"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="bg-[#1a1a1a]/95 backdrop-blur-xl border border-zinc-700/50 rounded-2xl p-4 flex flex-col gap-3">
            <textarea
              className="w-full border rounded-xl px-4 py-3 text-sm leading-relaxed resize-none focus:outline-none focus:ring-2 focus:ring-blue-500/20 min-h-[72px] bg-zinc-800/80 hover:bg-zinc-800 border-zinc-700 focus:border-blue-500 text-white placeholder-zinc-500 transition-all"
              placeholder="描述你想要生成的图片..."
              value={data.prompt || ""}
              onChange={(e) => updateNodeData(id, { prompt: e.target.value })}
              onWheel={(e) => e.stopPropagation()}
            />

            <div className="flex items-center gap-2">
              <select
                value={data.model || "BananaPro"}
                onChange={(e) => updateNodeData(id, { model: e.target.value })}
                className="h-8 px-3 text-sm rounded-lg bg-zinc-800/80 border border-zinc-700 text-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              >
                {imageModels.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>

              <select
                value={data.aspectRatio || "1:1"}
                onChange={(e) =>
                  updateNodeData(id, { aspectRatio: e.target.value })
                }
                className="h-8 px-3 text-sm rounded-lg bg-zinc-800/80 border border-zinc-700 text-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              >
                {aspectRatios.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>

              <select
                value={data.resolution || "1k"}
                onChange={(e) =>
                  updateNodeData(id, { resolution: e.target.value })
                }
                className="h-8 px-3 text-sm rounded-lg bg-zinc-800/80 border border-zinc-700 text-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              >
                {resolutions.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>

              <button
                className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-all border ${
                  data.promptOptimize
                    ? "text-blue-400 bg-blue-500/20 border-blue-500/30"
                    : "text-zinc-400 hover:text-white border-zinc-700 hover:border-zinc-600 hover:bg-zinc-700"
                }`}
                onClick={() =>
                  updateNodeData(id, { promptOptimize: !data.promptOptimize })
                }
              >
                <Sparkles
                  size={15}
                  fill={data.promptOptimize ? "currentColor" : "none"}
                />
              </button>

              <div className="flex-1" />

              <button
                onClick={handleGenerate}
                disabled={data.isLoading || !data.prompt}
                className={`shrink-0 h-8 px-4 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 whitespace-nowrap transition-all active:scale-[0.98] ${
                  data.isLoading || !data.prompt
                    ? "bg-gray-400 text-white cursor-not-allowed"
                    : "bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40"
                }`}
              >
                {data.isLoading ? (
                  <Loader2 className="animate-spin" size={15} />
                ) : (
                  <Wand2 size={15} />
                )}
                <span>{data.isLoading ? "生成中" : "生成"}</span>
              </button>
            </div>

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

TextToImageNode.displayName = "TextToImageNode";

export default memo(TextToImageNode);
