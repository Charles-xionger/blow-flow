"use client";

import { memo, useCallback, useState, useEffect } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { Handle, Position } from "@xyflow/react";
import { useCanvasStore } from "@/store/useCanvasStore";
import { Video, Sparkles, Wand2, Loader2, Link2 } from "lucide-react";
import type { NodeData } from "@/types";
import { getVideoModels } from "@/lib/model-registry";
import { EditableTitle } from "./shared/EditableTitle";
import { QuickAddNode } from "../canvas/QuickAddNode";
import { Textarea } from "@/components/ui/textarea";

const durations = [
  { value: "5s", label: "5秒" },
  { value: "10s", label: "10秒" },
  { value: "15s", label: "15秒" },
  { value: "20s", label: "20秒" },
];

const aspectRatios = [
  { value: "16:9", label: "16:9 横屏" },
  { value: "9:16", label: "9:16 竖屏" },
  { value: "1:1", label: "1:1 方形" },
];

const TextToVideoNode = ({ id, data, selected }: NodeProps<Node<NodeData>>) => {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const nodes = useCanvasStore((state) => state.nodes);
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds);
  const currentNode = nodes.find((n) => n.id === id);
  const nodePosition = currentNode?.position || { x: 0, y: 0 };
  const [videoModels, setVideoModels] = useState<
    Array<{ value: string; label: string }>
  >([]);

  // 只有在单选状态下才显示控制面板
  const shouldShowPanel = selected && selectedNodeIds.length === 1;

  // 从连接的文本节点读取 prompt
  const inputPrompt = useCanvasStore(
    useCallback(
      (state) => {
        const inputEdges = state.edges.filter((edge) => edge.target === id);
        if (inputEdges.length === 0) return null;

        const sourceNode = state.nodes.find(
          (n) => n.id === inputEdges[0].source,
        );
        return sourceNode?.data.prompt;
      },
      [id],
    ),
  );

  // 本地状态用于输入框，防止中文输入法问题
  const [localPrompt, setLocalPrompt] = useState(data.prompt || "");

  // 加载视频模型列表
  useEffect(() => {
    setVideoModels(getVideoModels());
  }, []);

  // 同步外部数据变化到本地状态
  useEffect(() => {
    setLocalPrompt(data.prompt || "");
  }, [data.prompt]);

  // 优先使用连接节点的 prompt，否则使用本地 prompt
  const effectivePrompt = inputPrompt || localPrompt;

  const handleGenerate = useCallback(
    async (skipCache = false) => {
      // 先同步本地输入到 store
      if (localPrompt !== data.prompt) {
        updateNodeData(id, { prompt: localPrompt });
      }

      const promptToUse = inputPrompt || localPrompt;
      if (!promptToUse) return;

      updateNodeData(id, { isLoading: true, error: undefined });

      try {
        const response = await fetch("/api/generate/video", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: promptToUse,
            model: data.model || "Sora 2",
            aspectRatio: data.aspectRatio || "16:9",
            duration: data.duration || "5s",
            promptOptimize: data.promptOptimize || false,
            skipCache, // 传递 skipCache 参数
          }),
        });

        const result = await response.json();

        if (result.success && result.data) {
          updateNodeData(id, {
            isLoading: false,
            videoSrc: result.data,
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
      inputPrompt,
      localPrompt,
      data.model,
      data.aspectRatio,
      data.duration,
      data.promptOptimize,
      updateNodeData,
    ],
  );

  const hasResult = !!data.videoSrc && !data.isLoading;

  return (
    <>
      {/* 可编辑标题 */}
      <EditableTitle
        nodeId={id}
        defaultTitle={data.label}
        customTitle={data.customTitle}
      />

      {/* 输入句柄 */}
      <Handle type="target" position={Position.Left} id="input" />

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
            ? "border-green-500 ring-2 ring-green-500/30"
            : "border-zinc-700/50"
        } bg-[#1a1a1a] overflow-hidden shadow-xl group transition-all duration-200`}
      >
        {hasResult ? (
          <div className="relative w-full h-full">
            <video
              src={data.videoSrc}
              className="w-full h-full object-contain"
              controls
            />
          </div>
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-zinc-500">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4 bg-zinc-800/50 text-zinc-500">
              <Video size={28} className="opacity-60" />
            </div>
            <span className="text-sm font-medium opacity-60">生视频</span>
            <span className="text-xs opacity-40 mt-1">选中节点开始创作</span>
          </div>
        )}

        {/* Loading Overlay */}
        {data.isLoading && (
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex flex-col items-center justify-center z-20">
            <Loader2 size={32} className="text-green-500 animate-spin mb-3" />
            <span className="text-white/80 text-sm font-medium">生成中...</span>
          </div>
        )}
      </div>

      {/* 控制面板 */}
      {shouldShowPanel && (
        <div
          className="absolute top-full left-1/2 -translate-x-1/2 min-w-130 pt-4 z-70 pointer-events-auto"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="bg-[#1a1a1a]/95 backdrop-blur-xl border-zinc-700/50 rounded-2xl p-4 flex flex-col gap-3 border">
            {/* 连接提示卡片 */}
            {inputPrompt && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-green-500/10 border border-green-500/30 text-green-400 text-sm">
                <Link2 size={16} className="shrink-0" />
                <span className="flex-1 truncate">使用连接节点的内容</span>
              </div>
            )}

            {/* Prompt 输入框 */}
            <Textarea
              className="nodrag w-full border rounded-xl px-4 py-3 text-sm leading-relaxed resize-none min-h-18 bg-zinc-800/80 hover:bg-zinc-800 border-zinc-700 focus:border-green-500 text-white placeholder-zinc-500"
              placeholder="描述你想要生成的视频..."
              value={localPrompt}
              onChange={(e) => setLocalPrompt(e.target.value)}
              onBlur={() => updateNodeData(id, { prompt: localPrompt })}
              onMouseDown={(e) => e.stopPropagation()}
              onWheel={(e) => e.stopPropagation()}
            />

            {/* 参数行 */}
            <div className="flex items-center gap-2">
              {/* 模型选择 */}
              <select
                value={data.model || videoModels[0]?.value || ""}
                onChange={(e) => updateNodeData(id, { model: e.target.value })}
                className="h-8 px-3 text-sm rounded-lg bg-zinc-800/80 border-zinc-700 text-white focus:outline-none focus:ring-2 focus:ring-green-500/20"
              >
                {videoModels.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>

              {/* 时长 */}
              <select
                value={data.duration || "5s"}
                onChange={(e) =>
                  updateNodeData(id, { duration: e.target.value })
                }
                className="h-8 px-3 text-sm rounded-lg bg-zinc-800/80 border-zinc-700 text-white focus:outline-none focus:ring-2 focus:ring-green-500/20"
              >
                {durations.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>

              {/* 宽高比 */}
              <select
                value={data.aspectRatio || "16:9"}
                onChange={(e) =>
                  updateNodeData(id, { aspectRatio: e.target.value })
                }
                className="h-8 px-3 text-sm rounded-lg bg-zinc-800/80 border-zinc-700 text-white focus:outline-none focus:ring-2 focus:ring-green-500/20"
              >
                {aspectRatios.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>

              {/* 提示词优化 */}
              <button
                className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-all border ${
                  data.promptOptimize
                    ? "text-green-400 bg-green-500/20 border-green-500/30"
                    : "text-zinc-400 hover:text-white border-zinc-700 hover:border-zinc-600 hover:bg-zinc-700"
                }`}
                onClick={() =>
                  updateNodeData(id, { promptOptimize: !data.promptOptimize })
                }
                title={`提示词优化: ${data.promptOptimize ? "开启" : "关闭"}`}
              >
                <Sparkles
                  size={15}
                  fill={data.promptOptimize ? "currentColor" : "none"}
                />
              </button>

              <div className="flex-1" />

              {/* 生成按钮 */}
              <button
                onClick={() => handleGenerate()}
                disabled={data.isLoading || (!inputPrompt && !localPrompt)}
                className={`shrink-0 h-8 px-4 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 whitespace-nowrap transition-all active:scale-[0.98] ${
                  data.isLoading || (!inputPrompt && !localPrompt)
                    ? "bg-gray-400 text-white cursor-not-allowed"
                    : "bg-linear-to-r from-green-600 to-green-500 hover:from-green-500 hover:to-green-400 text-white shadow-lg shadow-green-500/25 hover:shadow-green-500/40"
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

            {/* 错误提示 */}
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

TextToVideoNode.displayName = "TextToVideoNode";

export default memo(TextToVideoNode);
