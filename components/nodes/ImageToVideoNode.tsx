"use client";

import { memo, useCallback, useState, useEffect } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { BaseNode, NodeSurface } from "./BaseNode";
import { promptText } from "@/lib/canvas/prompt";
import { useCanvasStore } from "@/store/useCanvasStore";
import { Video, Sparkles, AlertCircle, Loader2, Wand2 } from "lucide-react";
import type { NodeData } from "@/types";
import { getVideoModels } from "@/lib/model-registry";
import { Textarea } from "@/components/ui/textarea";
import { ImageWithActions } from "@/components/ui/image-with-actions";
import { generationModels } from '@/lib/generation/client';
import type { PublicModel } from '@/lib/generation/types';
import { useGenerationTask } from '@/hooks/useGenerationTask';
import { VideoGenerationPanel } from './shared/VideoGenerationPanel';

const durations = [
  { value: "5", label: "5秒" },
  { value: "8", label: "8秒" },
  { value: "10", label: "10秒" },
];

const resolutions = [
  { value: "720P", label: "720P" },
  { value: "1080P", label: "1080P" },
  { value: "4K", label: "4K" },
];

const aspectRatios = [
  { value: "16:9", label: "横屏 (16:9)" },
  { value: "9:16", label: "竖屏 (9:16)" },
];

const ImageToVideoNode = (props: NodeProps<Node<NodeData>>) => {
  const { id, data, selected } = props;
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const singleSelected = useCanvasStore((state) => state.selectedNodeIds.length === 1);
  const task = useGenerationTask(id, data);
  const [taskModels, setTaskModels] = useState<PublicModel[]>([]);
  const taskModel = taskModels.find(m => m.id === data.model);

  // 只有在单选状态下才显示控制面板
  const shouldShowPanel = selected && singleSelected;

  // 优化：只订阅与此节点相关的数据，避免不必要的重新渲染
  const inputImage = useCanvasStore(
    useCallback(
      (state) => {
        const inputEdges = state.edges.filter((edge) => edge.target === id);
        if (inputEdges.length === 0) return null;

        const sourceNode = state.nodes.find(
          (n) => n.id === inputEdges[0].source,
        );
        if (!sourceNode) return null;

        // 支持角色节点 - 使用角色的第一张参考图
        if (sourceNode.data.characterData?.referenceImages?.[0]) {
          return sourceNode.data.characterData.referenceImages[0];
        }

        // 支持普通图片节点
        return sourceNode.data.imageSrc;
      },
      [id],
    ),
  );

  const [videoModels, setVideoModels] = useState<
    Array<{ id: string; value: string; label: string }>
  >([]);

  // 本地状态用于输入框，防止中文输入法问题
  const [localPrompt, setLocalPrompt] = useState(promptText(data.prompt));
  const [isGeneratingPrompt, setIsGeneratingPrompt] = useState(false);

  // 加载视频模型列表
  useEffect(() => {
    setVideoModels(getVideoModels());
    let active = true;
    generationModels().then(models => { if (active) setTaskModels(models.filter(m => m.category === 'VIDEO')); }).catch(() => {});
    return () => { active = false; };
  }, []);

  // 同步外部数据变化到本地状态
  useEffect(() => {
    setLocalPrompt(promptText(data.prompt));
  }, [data.prompt]);

  const handleGeneratePrompt = useCallback(async () => {
    if (!inputImage) return;

    setIsGeneratingPrompt(true);

    try {
      const response = await fetch("/api/generate-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeType: "imageToVideo",
          currentPrompt: localPrompt || undefined,
          context: {
            inputImage,
            duration: data.duration || "5",
            model: data.model,
          },
        }),
      });

      const result = await response.json();

      if (result.success && result.data) {
        const generatedPrompt = result.data;
        setLocalPrompt(generatedPrompt);
        updateNodeData(id, { prompt: generatedPrompt });
      } else {
        throw new Error(result.error || "生成提示词失败");
      }
    } catch (error) {
      console.error("Generate prompt error:", error);
      updateNodeData(id, {
        error: error instanceof Error ? error.message : "生成提示词失败",
      });
    } finally {
      setIsGeneratingPrompt(false);
    }
  }, [id, inputImage, localPrompt, data.duration, data.model, updateNodeData]);

  const handleGenerate = useCallback(
    async (skipCache = false) => {
      if (!promptText(data.prompt) || !inputImage) return;

      try {
        await task.detach();
        updateNodeData(id, { isLoading: true, error: undefined });
        const response = await fetch("/api/generate/image-to-video", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: promptText(data.prompt),
            inputImage,
            model: data.model || "wan2.6-i2v-flash",
            duration: parseInt(data.duration || "5"),
            resolution: data.resolution || "720P",
            aspectRatio: data.aspectRatio || "16:9",
            promptOptimize: data.promptOptimize || false,
            skipCache, // 传递 skipCache 参数
          }),
        });

        const result = await response.json();

        if (result.success && result.data) {
          updateNodeData(id, {
            isLoading: false,
            videoSrc: result.data,
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
    [id, data, inputImage, updateNodeData, task],
  );

  const hasResult = !!data.videoSrc && !data.isLoading;

  const modelOptions = [
    ...taskModels.map(m => ({ id: m.id, label: m.name + (m.configured ? '' : '（未配置）'), task: true })),
    ...videoModels.map(m => ({ id: m.id, label: m.label })),
  ];
  if (data.model && !modelOptions.some(m => m.id === data.model)) modelOptions.push({ id: data.model, label: data.model });
  if (taskModel || data.usesGenerationTasks || data.model === 'runninghub-h3')
    return <VideoGenerationPanel node={props} model={taskModel} models={modelOptions} task={task} />;

  return (
    <BaseNode {...props}>

      {/* 节点显示区域 */}
      <NodeSurface>
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
            <span className="text-sm font-medium opacity-60">图生视频</span>
            <span className="text-xs opacity-40 mt-1">选中节点开始创作</span>
          </div>
        )}

        {data.isLoading && (
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex flex-col items-center justify-center z-20">
            <Loader2 size={32} className="text-indigo-500 animate-spin mb-3" />
            <span className="text-white/80 text-sm font-medium">生成中...</span>
          </div>
        )}
      </NodeSurface>

      {/* 控制面板 */}
      {shouldShowPanel && (
        <div
          className="node-panel nodrag nopan nowheel absolute top-full left-1/2 -translate-x-1/2 min-w-100 pt-4 z-70 pointer-events-auto"
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
                  <ImageWithActions
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

            <Textarea
              className="nodrag w-full border rounded-xl px-4 py-3 text-sm leading-relaxed resize-none min-h-18 max-h-32 overflow-y-auto bg-zinc-800/80 hover:bg-zinc-800 border-zinc-700 focus:border-purple-500 text-white placeholder-zinc-500 max-h-32 overflow-y-auto"
              placeholder="描述你想要的视频内容..."
              value={localPrompt}
              onChange={(e) => {
                setLocalPrompt(e.target.value);
                updateNodeData(id, { prompt: e.target.value });
              }}
              onBlur={() => updateNodeData(id, { prompt: localPrompt })}
              onMouseDown={(e) => e.stopPropagation()}
              onWheel={(e) => e.stopPropagation()}
              rows={3}
            />

            {/* AI 生成提示词按钮 */}
            <button
              onClick={handleGeneratePrompt}
              disabled={isGeneratingPrompt || !inputImage}
              className={`w-full h-8 rounded-lg text-xs font-medium flex items-center justify-center gap-2 transition-all ${
                isGeneratingPrompt || !inputImage
                  ? "bg-zinc-800 text-zinc-500 cursor-not-allowed"
                  : "bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white"
              }`}
            >
              {isGeneratingPrompt ? (
                <>
                  <Loader2 className="animate-spin" size={14} />
                  <span>AI 生成提示词中...</span>
                </>
              ) : (
                <>
                  <Sparkles size={14} />
                  <span>{localPrompt ? "优化提示词" : "AI 生成提示词"}</span>
                </>
              )}
            </button>

            <div className="flex flex-col gap-2">
              {/* 第一行：模型和时长 */}
              <div className="flex items-center gap-2">
                <select
                  aria-label="视频模型"
                  value={data.model || videoModels[0]?.id || ""}
                  onChange={(e) =>
                    updateNodeData(id, { model: e.target.value, usesGenerationTasks: taskModels.some(m => m.id === e.target.value) })
                  }
                  className="flex-1 h-8 px-3 text-sm rounded-lg bg-zinc-800/80 border border-zinc-700 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                >
                  {modelOptions.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>

                <select
                  value={data.duration || "5"}
                  onChange={(e) =>
                    updateNodeData(id, { duration: e.target.value })
                  }
                  className="h-8 px-3 text-sm rounded-lg bg-zinc-800/80 border border-zinc-700 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                >
                  {durations.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* 第二行：分辨率和宽高比 */}
              <div className="flex items-center gap-2">
                <select
                  value={data.resolution || "720P"}
                  onChange={(e) =>
                    updateNodeData(id, { resolution: e.target.value })
                  }
                  className="flex-1 h-8 px-3 text-sm rounded-lg bg-zinc-800/80 border border-zinc-700 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                >
                  {resolutions.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>

                <select
                  value={data.aspectRatio || "16:9"}
                  onChange={(e) =>
                    updateNodeData(id, { aspectRatio: e.target.value })
                  }
                  className="flex-1 h-8 px-3 text-sm rounded-lg bg-zinc-800/80 border border-zinc-700 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                >
                  {aspectRatios.map((a) => (
                    <option key={a.value} value={a.value}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* 第三行：按钮组 */}
              <div className="flex items-center gap-2">
                <div className="flex-1" />

                <button
                  onClick={() => handleGenerate()}
                  disabled={data.isLoading || !localPrompt || !inputImage}
                  className={`shrink-0 h-8 px-4 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 whitespace-nowrap transition-all active:scale-[0.98] ${
                    data.isLoading || !localPrompt || !inputImage
                      ? "bg-gray-400 text-white cursor-not-allowed"
                      : "bg-linear-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400 text-white shadow-lg shadow-indigo-500/25 hover:shadow-indigo-500/40"
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
            </div>

            {data.error && (
              <div className="text-xs text-red-400 bg-red-500/10 px-3 py-2 rounded-lg border border-red-500/20">
                {data.error}
              </div>
            )}
          </div>
        </div>
      )}
    </BaseNode>
  );
};

ImageToVideoNode.displayName = "ImageToVideoNode";

export default memo(ImageToVideoNode);
