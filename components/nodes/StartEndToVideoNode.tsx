"use client";

import { memo, useCallback, useMemo, useState, useEffect } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { Handle, Position } from "@xyflow/react";
import { useCanvasStore } from "@/store/useCanvasStore";
import {
  Video,
  Sparkles,
  AlertCircle,
  ArrowRightLeft,
  Loader2,
  Wand2,
} from "lucide-react";
import type { NodeData } from "@/types";
import { getVideoModels } from "@/lib/model-registry";
import { EditableTitle } from "./shared/EditableTitle";
import { QuickAddNode } from "../canvas/QuickAddNode";
import { Textarea } from "@/components/ui/textarea";
import { ImageWithActions } from "@/components/ui/image-with-actions";

const durations = [
  { value: "5", label: "5秒" },
  { value: "8", label: "8秒" },
  { value: "10", label: "10秒" },
];

const resolutions = [
  { value: "480P", label: "480P" },
  { value: "720P", label: "720P" },
  { value: "1080P", label: "1080P" },
];

const aspectRatios = [
  { value: "16:9", label: "横屏 (16:9)" },
  { value: "9:16", label: "竖屏 (9:16)" },
];

const StartEndToVideoNode = ({
  id,
  data,
  selected,
}: NodeProps<Node<NodeData>>) => {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const nodes = useCanvasStore((state) => state.nodes);
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds);
  const currentNode = nodes.find((n) => n.id === id);
  const nodePosition = currentNode?.position || { x: 0, y: 0 };

  // 只有在单选状态下才显示控制面板
  const shouldShowPanel = selected && selectedNodeIds.length === 1;
  const edges = useCanvasStore((state) => state.edges);

  // 计算输入图片
  const inputImages = useMemo(() => {
    const inputEdges = edges.filter((edge) => edge.target === id);
    const images = inputEdges
      .map((edge) => {
        const sourceNode = nodes.find((n) => n.id === edge.source);
        if (!sourceNode) return null;

        // 支持角色节点 - 使用角色的第一张参考图
        if (sourceNode.data.characterData?.referenceImages?.[0]) {
          return sourceNode.data.characterData.referenceImages[0];
        }

        // 支持普通图片节点
        return sourceNode.data.imageSrc;
      })
      .filter(Boolean) as string[];

    return images.slice(0, 2); // 只取前两张
  }, [edges, nodes, id]);

  const [videoModels, setVideoModels] = useState<
    Array<{ value: string; label: string }>
  >([]);

  // 本地状态用于输入框，防止中文输入法问题
  const [localPrompt, setLocalPrompt] = useState(data.prompt || "");
  const [isGeneratingPrompt, setIsGeneratingPrompt] = useState(false);
  const [promptError, setPromptError] = useState<string | undefined>();

  // 同步外部数据变化到本地状态
  useEffect(() => {
    setLocalPrompt(data.prompt || "");
  }, [data.prompt]);

  // 加载视频模型列表 - 从数据库API异步获取
  useEffect(() => {
    const loadModels = async () => {
      try {
        // 先加载内置模型
        const builtinModels = getVideoModels();

        // 然后从数据库API获取配置的模型
        const response = await fetch("/api/model-config");
        if (response.ok) {
          const result = await response.json();
          if (result.success && result.data) {
            // 根据 category 字段过滤视频模型
            const dbModels = Object.entries(result.data)
              .filter(([, config]: [string, any]) => {
                return config.category === "VIDEO";
              })
              .map(([name]: [string, any]) => ({
                value: name, // 使用数据库中的 model_name 作为 value
                label: name, // 显示完整的模型名称
              }));

            console.log(
              "[StartEndToVideoNode] Loaded video models from database:",
              dbModels,
            );

            // 合并并去重
            const allModels = [...dbModels, ...builtinModels];
            const uniqueModels = allModels.filter(
              (model, index, self) =>
                index === self.findIndex((m) => m.value === model.value),
            );

            setVideoModels(uniqueModels);
            return;
          }
        }

        // 如果获取失败，使用内置模型
        setVideoModels(builtinModels);
      } catch (error) {
        console.error("[StartEndToVideoNode] Failed to load models:", error);
        // 降级到内置模型
        setVideoModels(getVideoModels());
      }
    };

    loadModels();
  }, []);

  const [startImage, endImage] = data.swapFrames
    ? [inputImages[1], inputImages[0]]
    : inputImages;

  const handleGeneratePrompt = useCallback(async () => {
    if (inputImages.length < 2) {
      setPromptError("需要连接两个图片节点");
      return;
    }

    setIsGeneratingPrompt(true);
    setPromptError(undefined);

    try {
      const response = await fetch("/api/generate-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeType: "startEndToVideo",
          currentPrompt: localPrompt,
          context: {
            startImage,
            endImage,
            duration: data.duration || "5",
            resolution: data.resolution || "720P",
            aspectRatio: data.aspectRatio || "16:9",
            model: data.model,
          },
        }),
      });

      const result = await response.json();
      console.log("[StartEndToVideoNode] Prompt generation result:", result);

      if (result.success && result.data) {
        setLocalPrompt(result.data);
        updateNodeData(id, { prompt: result.data });
      } else {
        throw new Error(result.error || "生成失败");
      }
    } catch (error) {
      console.error("[StartEndToVideoNode] Prompt generation error:", error);
      setPromptError(error instanceof Error ? error.message : "生成提示词失败");
    } finally {
      setIsGeneratingPrompt(false);
    }
  }, [
    id,
    localPrompt,
    inputImages,
    startImage,
    endImage,
    data.aspectRatio,
    data.duration,
    data.resolution,
    data.model,
    updateNodeData,
  ]);

  const handleGenerate = useCallback(async () => {
    // 先同步本地输入到 store
    if (localPrompt !== data.prompt) {
      updateNodeData(id, { prompt: localPrompt });
    }

    if (!localPrompt || inputImages.length < 2) return;

    updateNodeData(id, { isLoading: true, error: undefined });

    const requestPayload = {
      prompt: localPrompt,
      startImage,
      endImage,
      model:
        data.model ||
        videoModels[0]?.value ||
        "wan2.2-kf2v-flash-首尾帧生成视频模型",
      duration: parseInt(data.duration || "5"),
      resolution: data.resolution || "720P",
      aspectRatio: data.aspectRatio || "16:9",
      promptOptimize: data.promptOptimize || false,
    };

    console.log(
      "[StartEndToVideoNode] Generating video with payload:",
      requestPayload,
    );

    try {
      const response = await fetch("/api/generate/start-end-to-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload),
      });

      const result = await response.json();
      console.log("[StartEndToVideoNode] API response:", result);

      if (result.success && result.data) {
        updateNodeData(id, {
          isLoading: false,
          videoSrc: result.data,
          inputImages,
        });
      } else {
        throw new Error(result.error || "生成失败");
      }
    } catch (error) {
      console.error("[StartEndToVideoNode] Generation error:", error);
      updateNodeData(id, {
        isLoading: false,
        error: error instanceof Error ? error.message : "生成失败",
      });
    }
  }, [
    id,
    localPrompt,
    data.prompt,
    data.model,
    data.aspectRatio,
    data.duration,
    data.resolution,
    data.promptOptimize,
    inputImages,
    startImage,
    endImage,
    updateNodeData,
    videoModels,
  ]);

  const hasResult = !!data.videoSrc && !data.isLoading;

  return (
    <>
      {/* 输入句柄 */}
      <Handle type="target" position={Position.Left} id="input" />

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
            ? "border-pink-500 ring-2 ring-pink-500/30"
            : "border-zinc-700/50"
        } bg-[#1a1a1a] overflow-hidden shadow-xl group transition-all duration-200`}
      >
        {hasResult ? (
          <div className="relative w-full h-full">
            <video
              src={data.videoSrc}
              className="w-full h-full object-contain"
              controls
              loop
            />
          </div>
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-zinc-500">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4 bg-zinc-800/50 text-zinc-500">
              <Video size={28} className="opacity-60" />
            </div>
            <span className="text-sm font-medium opacity-60">首尾帧生视频</span>
            <span className="text-xs opacity-40 mt-1">选中节点开始创作</span>
          </div>
        )}

        {data.isLoading && (
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex flex-col items-center justify-center z-20">
            <Loader2 size={32} className="text-pink-500 animate-spin mb-3" />
            <span className="text-white/80 text-sm font-medium">生成中...</span>
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
            {/* 输入图片预览 */}
            {inputImages.length === 2 ? (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-medium text-zinc-400">
                    首尾帧
                  </label>
                  <button
                    onClick={() =>
                      updateNodeData(id, { swapFrames: !data.swapFrames })
                    }
                    className="text-xs text-pink-400 hover:text-pink-300 flex items-center gap-1 transition-colors"
                    disabled={data.isLoading}
                  >
                    <ArrowRightLeft size={12} />
                    交换
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="relative rounded-lg overflow-hidden border-2 border-green-500/50 h-24 bg-zinc-800/50">
                    <ImageWithActions
                      src={startImage}
                      alt="Start Frame"
                      className="w-full h-full object-contain"
                    />
                    <span className="absolute top-1 left-1 bg-green-500 text-white text-xs px-1.5 py-0.5 rounded z-20">
                      首帧
                    </span>
                  </div>
                  <div className="relative rounded-lg overflow-hidden border-2 border-red-500/50 h-24 bg-zinc-800/50">
                    <ImageWithActions
                      src={endImage}
                      alt="End Frame"
                      className="w-full h-full object-contain"
                    />
                    <span className="absolute top-1 left-1 bg-red-500 text-white text-xs px-1.5 py-0.5 rounded z-20">
                      尾帧
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 px-3 py-2 rounded-lg border border-amber-500/20">
                <AlertCircle size={16} />
                <span>
                  请连接两个图片节点作为首尾帧（当前 {inputImages.length}/2）
                </span>
              </div>
            )}

            <Textarea
              className="nodrag w-full border rounded-xl px-4 py-3 text-sm leading-relaxed resize-none min-h-18 max-h-32 overflow-y-auto bg-zinc-800/80 hover:bg-zinc-800 border-zinc-700 focus:border-purple-500 text-white placeholder-zinc-500"
              placeholder="描述你想要的视频内容..."
              value={localPrompt}
              onChange={(e) => setLocalPrompt(e.target.value)}
              onBlur={() => updateNodeData(id, { prompt: localPrompt })}
              onMouseDown={(e) => e.stopPropagation()}
              onWheel={(e) => e.stopPropagation()}
              rows={3}
            />

            <div className="flex items-center gap-2">
              <select
                value={data.model || videoModels[0]?.value || ""}
                onChange={(e) => updateNodeData(id, { model: e.target.value })}
                className="h-8 px-3 text-sm rounded-lg bg-zinc-800/80 border border-zinc-700 text-white focus:outline-none focus:ring-2 focus:ring-pink-500/20"
              >
                {videoModels.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>

              <select
                value={data.aspectRatio || "16:9"}
                onChange={(e) =>
                  updateNodeData(id, { aspectRatio: e.target.value })
                }
                className="h-8 px-3 text-sm rounded-lg bg-zinc-800/80 border border-zinc-700 text-white focus:outline-none focus:ring-2 focus:ring-pink-500/20"
              >
                {aspectRatios.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>

              <select
                value={data.resolution || "720P"}
                onChange={(e) =>
                  updateNodeData(id, { resolution: e.target.value })
                }
                className="h-8 px-3 text-sm rounded-lg bg-zinc-800/80 border border-zinc-700 text-white focus:outline-none focus:ring-2 focus:ring-pink-500/20"
              >
                {resolutions.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>

              <select
                value={data.duration || "5"}
                onChange={(e) =>
                  updateNodeData(id, { duration: e.target.value })
                }
                className="h-8 px-3 text-sm rounded-lg bg-zinc-800/80 border border-zinc-700 text-white focus:outline-none focus:ring-2 focus:ring-pink-500/20"
              >
                {durations.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>

              <button
                className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-all border ${
                  isGeneratingPrompt
                    ? "text-pink-400 bg-pink-500/20 border-pink-500/30 cursor-wait"
                    : "text-zinc-400 hover:text-pink-400 border-zinc-700 hover:border-pink-500/30 hover:bg-pink-500/10"
                }`}
                onClick={handleGeneratePrompt}
                disabled={isGeneratingPrompt || inputImages.length < 2}
                title={"AI生成提示词"}
              >
                {isGeneratingPrompt ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <Sparkles size={15} />
                )}
              </button>

              <div className="flex-1" />

              <button
                onClick={handleGenerate}
                disabled={
                  data.isLoading || !localPrompt || inputImages.length < 2
                }
                className={`shrink-0 h-8 px-4 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 whitespace-nowrap transition-all active:scale-[0.98] ${
                  data.isLoading || !localPrompt || inputImages.length < 2
                    ? "bg-gray-400 text-white cursor-not-allowed"
                    : "bg-linear-to-r from-pink-600 to-pink-500 hover:from-pink-500 hover:to-pink-400 text-white shadow-lg shadow-pink-500/25 hover:shadow-pink-500/40"
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

            {promptError && (
              <div className="text-xs text-amber-400 bg-amber-500/10 px-3 py-2 rounded-lg border border-amber-500/20">
                {promptError}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
};

StartEndToVideoNode.displayName = "StartEndToVideoNode";

export default memo(StartEndToVideoNode);
