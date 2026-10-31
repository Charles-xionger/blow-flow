"use client";

import { memo, useCallback, useState, useEffect, useMemo } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { BaseNode, NodeSurface } from "./BaseNode";
import { useNodeInputs } from "@/hooks/useNodeInputs";
import { useCanvasStore } from "@/store/useCanvasStore";
import { Image, Sparkles, Wand2, Loader2, Link2 } from "lucide-react";
import type { NodeData } from "@/types";
import { toast } from "sonner";
import { getImageModels } from "@/lib/model-registry";
import { Textarea } from "@/components/ui/textarea";
import { ImageWithActions } from "@/components/ui/image-with-actions";

import { validGenerationDimensions } from "@/lib/generation/dimensions";
import { generationModels } from "@/lib/generation/client";
import type { PublicModel } from "@/lib/generation/types";
import { useGenerationTask } from "@/hooks/useGenerationTask";

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

const TextToImageNode = (props: NodeProps<Node<NodeData>>) => {
  const { id, data, selected } = props;
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const singleSelected = useCanvasStore((state) => state.selectedNodeIds.length === 1);
  const [imageModels, setImageModels] = useState<
    Array<{ value: string; label: string }>
  >([]);

  const [taskModels, setTaskModels] = useState<PublicModel[]>([]);
  const taskModel = taskModels.find(m => m.id === data.model);
  const { start: createTask, resume: resumeTask, detach: detachTask } = useGenerationTask(id, data);
  const taskUnavailable = (data.usesGenerationTasks && !taskModel) || (!!taskModel && (!taskModel.configured || data.generationBlocked));

  // 获取当前节点位置

  // 只有在单选状态下才显示控制面板
  const shouldShowPanel = selected && singleSelected;

  // 从连接的节点读取数据（文本节点的prompt或角色节点的数据）
  const inputs = useNodeInputs(id);

  const { inputPrompt, characterData, referenceImages } = useMemo(() => {
    let prompt = null;
    let character = null;
    let refImages: string[] = [];

    for (const sourceData of inputs) {
      if (!sourceData) continue;

      // 文本节点提供prompt
      if (sourceData.prompt) {
        prompt = sourceData.prompt;
      }

      // 角色节点提供角色数据和参考图
      if (sourceData.characterData) {
        character = sourceData.characterData;
        refImages = character.referenceImages || [];
      }
    }

    return {
      inputPrompt: prompt,
      characterData: character,
      referenceImages: refImages,
    };
  }, [inputs]);

  // 本地状态用于输入框，防止中文输入法问题
  const [localPrompt, setLocalPrompt] = useState(data.prompt || "");

  // 加载图片模型列表
  useEffect(() => {
    setImageModels(getImageModels());
    let active = true;
    generationModels().then(models => { if (active) setTaskModels(models); }).catch(() => {});
    return () => { active = false; };
  }, []);

  // 同步外部数据变化到本地状态
  useEffect(() => {
    setLocalPrompt(data.prompt || "");
  }, [data.prompt]);

  // 保存为角色
  const handleSaveAsCharacter = async () => {
    if (!data.imageSrc) return;

    const toastId = toast.loading("正在分析图片...");

    try {
      // 调用图片分析 API
      const analyzeResponse = await fetch("/api/character/analyze-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageUrl: data.imageSrc,
          prompt: localPrompt || data.prompt || "",
        }),
      });

      const analyzeResult = await analyzeResponse.json();

      if (analyzeResult.success) {
        console.log(
          "[TextToImageNode] Analysis completed:",
          analyzeResult.data,
        );

        toast.loading("正在保存角色...", { id: toastId });

        // 直接保存到数据库
        const saveResponse = await fetch("/api/character", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: analyzeResult.data.name,
            description: analyzeResult.data.description,
            referenceImages: [data.imageSrc],
            tags: analyzeResult.data.tags || [],
          }),
        });

        const saveResult = await saveResponse.json();

        if (saveResult.success) {
          toast.success(`角色"${analyzeResult.data.name}"已保存！`, {
            id: toastId,
          });

          // 触发角色库刷新事件
          window.dispatchEvent(new CustomEvent("characterSaved"));
        } else {
          throw new Error(saveResult.error || "保存失败");
        }
      } else {
        throw new Error(analyzeResult.error);
      }
    } catch (error) {
      console.error("Failed to save character:", error);
      toast.error(
        `保存失败: ${error instanceof Error ? error.message : "未知错误"}`,
        { id: toastId },
      );
    }
  };

  const handleGenerate = useCallback(async () => {
    // 先同步本地输入到 store
    if (localPrompt !== data.prompt) {
      updateNodeData(id, { prompt: localPrompt });
    }

    let promptToUse = inputPrompt || localPrompt;
    if (!promptToUse) return;

    // 如果有角色数据，注入角色描述到提示词
    if (characterData) {
      promptToUse = `${characterData.description}. ${promptToUse}`;
    }

    if (data.usesGenerationTasks && !taskModel && !data.pendingGeneration) {
      updateNodeData(id, { error: "模型目录暂时不可用" });
      return;
    }
    if (taskModel || data.pendingGeneration) {
      if (referenceImages.length || data.inputImages?.length) {
        updateNodeData(id, { error: "此模型不支持参考图" });
        return;
      }
      if (!taskModel && !data.pendingGeneration) return;
      if (taskModel && !data.pendingGeneration) {
        const dims = taskModel.capabilities.dimensions;
        if (!validGenerationDimensions(dims, data.generationWidth ?? dims.defaultWidth, data.generationHeight ?? dims.defaultHeight)) {
          updateNodeData(id, { error: `尺寸须为 ${dims.min}–${dims.max} 范围内 ${dims.step} 的倍数` });
          return;
        }
      }
      await createTask(data.pendingGeneration || {
        requestId: crypto.randomUUID(), modelId: taskModel?.id || data.pendingGeneration!.modelId,
        canvasId: useCanvasStore.getState().currentWorkflowId || "draft", nodeId: id,
        input: { prompt: promptToUse,
          width: data.generationWidth ?? taskModel!.capabilities.dimensions.defaultWidth,
          height: data.generationHeight ?? taskModel!.capabilities.dimensions.defaultHeight },
      });
      return;
    }

    try { await detachTask(); }
    catch {
      updateNodeData(id, { error: "无法保存任务关联变更，请稍后重试" });
      return;
    }
    updateNodeData(id, { isLoading: true, error: undefined });

    try {
      const response = await fetch("/api/generate/image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: promptToUse,
          model: data.model || "BananaPro",
          aspectRatio: data.aspectRatio || "1:1",
          resolution: data.resolution || "1k",
          count: data.count || 1,
          promptOptimize: data.promptOptimize || false,
          inputImages: referenceImages.length > 0 ? referenceImages : undefined,
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
    inputPrompt,
    localPrompt,
    characterData,
    referenceImages,
    taskModel,
    detachTask,
    data.usesGenerationTasks,
    createTask,
    data.pendingGeneration,
    data.generationWidth,
    data.generationHeight,
    data.inputImages,
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
    <BaseNode {...props}>

      {/* 角色信息提示 */}
      {characterData && (
        <div className="absolute -top-6 left-0 flex items-center gap-1 text-xs text-purple-400 bg-purple-900/30 px-2 py-0.5 rounded">
          <span>🎭</span>
          <span>{characterData.name}</span>
        </div>
      )}

      {/* 节点显示区域 */}
      <NodeSurface>
        {hasResult ? (
          <div className="relative w-full h-full">
            <ImageWithActions
              src={data.imageSrc}
              alt="Generated"
              className="w-full h-full object-contain"
              onSaveAsCharacter={handleSaveAsCharacter}
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
            <span className="text-white/80 text-sm font-medium">{data.generationTaskId ? data.generationStatus : "生成中..."}</span>
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
            {/* 连接提示卡片 */}
            {inputPrompt && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-500/10 border border-blue-500/30 text-blue-400 text-sm">
                <Link2 size={16} className="shrink-0" />
                <span className="flex-1 truncate">使用连接节点的内容</span>
              </div>
            )}

            {/* Prompt 输入框 */}
            <Textarea
              className="nodrag w-full border rounded-xl px-4 py-3 text-sm leading-relaxed resize-none min-h-18 bg-zinc-800/80 hover:bg-zinc-800 border-zinc-700 focus:border-blue-500 text-white placeholder-zinc-500 max-h-32 overflow-y-auto"
              placeholder="描述你想要生成的图片..."
              value={localPrompt}
              onChange={(e) => setLocalPrompt(e.target.value)}
              onBlur={() => updateNodeData(id, { prompt: localPrompt })}
              onMouseDown={(e) => e.stopPropagation()}
              onWheel={(e) => e.stopPropagation()}
            />

            <div className="flex items-center gap-2">
              <select
                value={data.model || imageModels[0]?.value || ""}
                disabled={data.isLoading || !!data.pendingGeneration || data.generationBlocked}
                onChange={(e) => updateNodeData(id, { model: e.target.value, usesGenerationTasks: taskModels.some(m => m.id === e.target.value) })}
                className="h-8 px-3 text-sm rounded-lg bg-zinc-800/80 border border-zinc-700 text-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              >
                {taskModels.map(m => <option key={m.id} value={m.id}>{m.name}{m.configured ? "" : "（未配置）"}</option>)}
                {imageModels.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>

              {!taskModel && <>
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

              </>}

              <div className="flex-1" />

              <button
                onClick={handleGenerate}
                disabled={data.isLoading || taskUnavailable || (!inputPrompt && !localPrompt)}
                className={`shrink-0 h-8 px-4 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 whitespace-nowrap transition-all active:scale-[0.98] ${
                  data.isLoading || (!inputPrompt && !localPrompt)
                    ? "bg-gray-400 text-white cursor-not-allowed"
                    : "bg-linear-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40"
                }`}
              >
                {data.isLoading ? (
                  <Loader2 className="animate-spin" size={15} />
                ) : (
                  <Wand2 size={15} />
                )}
                <span>{data.isLoading ? "生成中" : data.pendingGeneration ? "恢复原请求" : data.generationTaskId ? "重新生成" : "生成"}</span>
              </button>
            </div>

            {taskModel && <div className="flex flex-col gap-2 text-xs text-zinc-300">
              <div className="flex items-center gap-2">
                {(["generationWidth", "generationHeight"] as const).map((field, index) => {
                  const dims = taskModel.capabilities.dimensions;
                  return <label key={field}>{index === 0 ? "宽" : "高"}
                    <input aria-label={index === 0 ? "生成宽度" : "生成高度"} type="number"
                      min={dims.min} max={dims.max} step={dims.step}
                      value={data[field] ?? (index === 0 ? dims.defaultWidth : dims.defaultHeight)}
                      onChange={e => updateNodeData(id, { [field]: Number(e.target.value) })}
                      className="ml-2 w-20 bg-zinc-800 rounded px-2 py-1" />
                  </label>;
                })}
              </div>
              <span>实际生成尺寸：{data.generationWidth ?? taskModel.capabilities.dimensions.defaultWidth} × {data.generationHeight ?? taskModel.capabilities.dimensions.defaultHeight} px</span>
              <span>仅文生图，不支持参考图。尺寸须为 {taskModel.capabilities.dimensions.step} 的倍数。</span>
              {!taskModel.configured && <span>请管理员配置平台连接</span>}
            </div>}
            {data.generationBlocked && data.generationTaskId && <button type="button"
              onClick={() => void resumeTask()} className="text-sm text-blue-300">继续查询原任务</button>}
            {data.generationStatus && <div role="status" className="text-xs text-blue-300">{data.generationStatus}</div>}
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

TextToImageNode.displayName = "TextToImageNode";

export default memo(TextToImageNode);
