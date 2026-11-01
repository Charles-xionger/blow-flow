"use client";

import { memo, useCallback, useState, useEffect, useMemo } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { BaseNode, NodeSurface } from "./BaseNode";
import { useNodeInputs } from "@/hooks/useNodeInputs";
import { useCanvasStore } from "@/store/useCanvasStore";
import { Image as ImageIcon, Sparkles, Wand2, Loader2, Link2 } from "lucide-react";
import type { NodeData } from "@/types";
import { toast } from "sonner";
import { getImageModels } from "@/lib/model-registry";
import { Textarea } from "@/components/ui/textarea";
import { ImageWithActions } from "@/components/ui/image-with-actions";

import { validGenerationDimensions } from "@/lib/generation/dimensions";
import { generationModels } from "@/lib/generation/client";
import type { PublicModel } from "@/lib/generation/types";
import { useGenerationTask } from "@/hooks/useGenerationTask";
import { imagePreviewSize } from "@/lib/generation/image-dimensions";
import { ImageSizeSettings } from "./shared/ImageSizeSettings";
import { ImageModelSettings } from "./shared/ImageModelSettings";
import { ImageGenerationPanel } from "./shared/ImageGenerationPanel";
import imageStyles from "./shared/ImageGeneration.module.css";

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
  const { start: createTask, resume: resumeTask, retrySave: retrySaveTask, detach: detachTask } = useGenerationTask(id, data);
  const taskUnavailable = (data.usesGenerationTasks && !taskModel) || (!!taskModel && (!taskModel.configured || data.generationBlocked));

  // 获取当前节点位置

  // 只有在单选状态下才显示控制面板
  const shouldShowPanel = selected && singleSelected && !props.dragging;

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
  const generationWidth = data.generationWidth ?? taskModel?.capabilities.dimensions.defaultWidth;
  const generationHeight = data.generationHeight ?? taskModel?.capabilities.dimensions.defaultHeight;
  const [ratioWidth, ratioHeight] = (data.aspectRatio || '1:1').split(':').map(Number);
  const displaySize = taskModel && generationWidth && generationHeight
    ? imagePreviewSize(generationWidth, generationHeight) : imagePreviewSize(ratioWidth, ratioHeight);

  return (
    <BaseNode {...props} displaySize={displaySize} titleAccessory={taskModel && <span
      className="shrink-0 text-[10px] text-zinc-400 tabular-nums">{generationWidth} × {generationHeight} px</span>}>

      {/* 角色信息提示 */}
      {characterData && (
        <div className="absolute -top-6 left-0 flex items-center gap-1 text-xs text-purple-400 bg-purple-900/30 px-2 py-0.5 rounded">
          <span>🎭</span>
          <span>{characterData.name}</span>
        </div>
      )}

      {/* 节点显示区域 */}
      <NodeSurface testId="image-preview">
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
              <ImageIcon size={28} className="opacity-60" aria-hidden />
            </div>
            <span className="text-sm font-medium opacity-60">生图</span>
            <span className="text-xs opacity-40 mt-1">{selected ? "输入提示词开始创作" : "选中节点开始创作"}</span>
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
        <ImageGenerationPanel>
            {/* 连接提示卡片 */}
            {inputPrompt && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-500/10 border border-blue-500/30 text-blue-400 text-sm">
                <Link2 size={16} className="shrink-0" />
                <span className="flex-1 truncate">使用连接节点的内容</span>
              </div>
            )}

            {/* Prompt 输入框 */}
            <Textarea
              className={`${imageStyles.prompt} nodrag`}
              placeholder="描述你想要生成的图片..."
              value={localPrompt}
              onChange={(e) => {
                setLocalPrompt(e.target.value);
                updateNodeData(id, { prompt: e.target.value });
              }}
              onBlur={() => updateNodeData(id, { prompt: localPrompt })}
              onMouseDown={(e) => e.stopPropagation()}
              onWheel={(e) => e.stopPropagation()}
            />

            <div className={imageStyles.foot}>
              {taskModel && <ImageSizeSettings width={generationWidth!} height={generationHeight!}
                limits={taskModel.capabilities.dimensions} preference={data.generationSizePreset}
                disabled={data.isLoading || !!data.pendingGeneration || data.generationBlocked}
                onChange={(size, preset) => updateNodeData(id, { generationWidth: size.width, generationHeight: size.height, generationSizePreset: preset })} />}
              {!taskModel && <ImageModelSettings aspectRatio={data.aspectRatio || '1:1'} resolution={data.resolution || '1k'}
                ratios={aspectRatios} resolutions={resolutions} disabled={data.isLoading}
                onChange={settings => updateNodeData(id, settings)} />}
              <select
                aria-label="生图模型"
                value={data.model || imageModels[0]?.value || ""}
                disabled={data.isLoading || !!data.pendingGeneration || data.generationBlocked}
                onChange={(e) => updateNodeData(id, { model: e.target.value, usesGenerationTasks: taskModels.some(m => m.id === e.target.value) })}
                className={imageStyles.model}
              >
                {taskModels.map(m => <option key={m.id} value={m.id}>{m.name}{m.configured ? "" : "（未配置）"}</option>)}
                {imageModels.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>

              {!taskModel && <>
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

              </>}

              <div className="flex-1" />

              <button
                onClick={handleGenerate}
                disabled={data.isLoading || taskUnavailable || (!inputPrompt && !localPrompt)}
                className={`shrink-0 h-8 px-4 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 whitespace-nowrap transition-all active:scale-[0.98] ${
                  data.isLoading || taskUnavailable || (!inputPrompt && !localPrompt)
                    ? "bg-zinc-800 text-zinc-500 cursor-not-allowed"
                    : "bg-purple-600 hover:bg-purple-500 text-white"
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

            {taskModel && <div className="text-[11px] text-zinc-500">
              <span>仅文生图 · 不支持参考图</span>
              {!taskModel.configured && <span> · 请管理员配置平台连接</span>}
            </div>}
            {data.generationBlocked && data.generationTaskId && <button type="button"
              onClick={() => void resumeTask()} className="text-sm text-blue-300">继续查询原任务</button>}
            {(data.generationCanRetrySave || data.generationSaving) && data.generationTaskId && <button type="button"
              disabled={!data.generationCanRetrySave || data.generationSaving}
              onClick={() => void retrySaveTask()} className="text-sm text-blue-300 disabled:opacity-50">
              {data.generationSaving ? "保存中…" : "重试保存（不重新生成）"}
            </button>}
            {data.generationStatus && <div role="status" className="text-xs text-blue-300">{data.generationStatus}</div>}
            {data.error && (
              <div className="text-xs text-red-400 bg-red-500/10 px-3 py-2 rounded-lg border border-red-500/20">
                {data.error}
              </div>
            )}
        </ImageGenerationPanel>
      )}
    </BaseNode>
  );
};

TextToImageNode.displayName = "TextToImageNode";

export default memo(TextToImageNode);
