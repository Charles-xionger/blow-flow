"use client";

import { memo, useCallback, useMemo, useState, useEffect } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { Handle, Position } from "@xyflow/react";
import { useCanvasStore } from "@/store/useCanvasStore";
import { Image, Sparkles, AlertCircle, Loader2, Wand2 } from "lucide-react";
import type { NodeData } from "@/types";
import { getImageModels } from "@/lib/model-registry";

const aspectRatios = [
  { value: "1:1", label: "1:1 方形" },
  { value: "16:9", label: "16:9 横屏" },
  { value: "9:16", label: "9:16 竖屏" },
];

const ImageToImageNode = ({
  id,
  data,
  selected,
}: NodeProps<Node<NodeData>>) => {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);

  // 优化：只订阅与此节点相关的数据，避免不必要的重新渲染
  const inputImage = useCanvasStore(
    useCallback(
      (state) => {
        const inputEdges = state.edges.filter((edge) => edge.target === id);
        if (inputEdges.length === 0) return null;

        const sourceNode = state.nodes.find(
          (n) => n.id === inputEdges[0].source,
        );
        return sourceNode?.data.imageSrc;
      },
      [id],
    ),
  );

  const [imageModels, setImageModels] = useState<
    Array<{ value: string; label: string }>
  >([]);

  // 加载图片模型列表
  useEffect(() => {
    setImageModels(getImageModels());
  }, []);

  const handleGenerate = useCallback(
    async (skipCache = false) => {
      if (!data.prompt || !inputImage) return;

      updateNodeData(id, { isLoading: true, error: undefined });

      try {
        const response = await fetch("/api/generate/image-to-image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: data.prompt,
            inputImage,
            model: data.model || "BananaPro",
            aspectRatio: data.aspectRatio || "1:1",
            promptOptimize: data.promptOptimize || false,
            skipCache, // 传递 skipCache 参数
          }),
        });

        const result = await response.json();

        if (result.success && result.data) {
          updateNodeData(id, {
            isLoading: false,
            imageSrc: result.data,
            inputImages: [inputImage],
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
    },
    [
      id,
      data.prompt,
      data.model,
      data.aspectRatio,
      data.promptOptimize,
      inputImage,
      updateNodeData,
    ],
  );

  const hasResult = !!data.imageSrc && !data.isLoading;

  return (
    <>
      {/* 输入句柄 */}
      <Handle type="target" position={Position.Left} id="input" />

      {/* 输出句柄 */}
      <Handle type="source" position={Position.Right} id="output" />

      {/* 节点显示区域 */}
      <div
        style={{ width: "320px", height: "240px" }}
        className={`relative rounded-2xl border ${
          selected
            ? "border-purple-500 ring-2 ring-purple-500/30"
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
            <span className="text-sm font-medium opacity-60">图生图</span>
            <span className="text-xs opacity-40 mt-1">选中节点开始创作</span>
          </div>
        )}

        {data.isLoading && (
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex flex-col items-center justify-center z-20">
            <Loader2 size={32} className="text-purple-500 animate-spin mb-3" />
            <span className="text-white/80 text-sm font-medium">生成中...</span>
          </div>
        )}
      </div>

      {/* 控制面板 */}
      {selected && (
        <div
          className="absolute top-full left-1/2 -translate-x-1/2 min-w-100 pt-4 z-70 pointer-events-auto"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="bg-[#1a1a1a]/95 backdrop-blur-xl border border-zinc-700/50 rounded-2xl p-4 flex flex-col gap-3">
            {/* 输入图片预览 */}
            {inputImage ? (
              <div>
                <label className="text-xs font-medium text-zinc-400 mb-2 block">
                  输入图片
                </label>
                <div className="relative rounded-lg overflow-hidden h-32 bg-zinc-800/50">
                  <img
                    src={inputImage}
                    alt="Input"
                    className="w-full h-full object-contain"
                  />
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 px-3 py-2 rounded-lg border border-amber-500/20">
                <AlertCircle size={16} />
                <span>请连接一个图片节点作为输入</span>
              </div>
            )}

            <textarea
              className="nodrag w-full border rounded-xl px-4 py-3 text-sm leading-relaxed resize-none focus:outline-none focus:ring-2 focus:ring-purple-500/20 min-h-18 bg-zinc-800/80 hover:bg-zinc-800 border-zinc-700 focus:border-purple-500 text-white placeholder-zinc-500 transition-all"
              placeholder="描述你想要的变化..."
              value={data.prompt || ""}
              onChange={(e) => updateNodeData(id, { prompt: e.target.value })}
              onWheel={(e) => e.stopPropagation()}
              rows={3}
            />

            <div className="flex items-center gap-2">
              <select
                value={data.model || imageModels[0]?.value || ""}
                onChange={(e) => updateNodeData(id, { model: e.target.value })}
                className="h-8 px-3 text-sm rounded-lg bg-zinc-800/80 border border-zinc-700 text-white focus:outline-none focus:ring-2 focus:ring-purple-500/20"
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
                className="h-8 px-3 text-sm rounded-lg bg-zinc-800/80 border border-zinc-700 text-white focus:outline-none focus:ring-2 focus:ring-purple-500/20"
              >
                {aspectRatios.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>

              <button
                className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-all border ${
                  data.promptOptimize
                    ? "text-purple-400 bg-purple-500/20 border-purple-500/30"
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
                onClick={() => handleGenerate()}
                disabled={data.isLoading || !data.prompt || !inputImage}
                className={`shrink-0 h-8 px-4 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 whitespace-nowrap transition-all active:scale-[0.98] ${
                  data.isLoading || !data.prompt || !inputImage
                    ? "bg-gray-400 text-white cursor-not-allowed"
                    : "bg-linear-to-r from-purple-600 to-purple-500 hover:from-purple-500 hover:to-purple-400 text-white shadow-lg shadow-purple-500/25 hover:shadow-purple-500/40"
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

ImageToImageNode.displayName = "ImageToImageNode";

export default memo(ImageToImageNode);
