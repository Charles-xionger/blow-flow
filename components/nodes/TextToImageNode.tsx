"use client";

import { memo, useCallback, useState, useEffect, useMemo } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import { useUpstreamNodes } from "@/hooks/useUpstreamNodes";
import { useCanvasStore } from "@/store/useCanvasStore";
import { Image as ImageIcon, Sparkles, Loader2 } from "lucide-react";
import type { NodeData } from "@/types";
import { toast } from "sonner";
import { getImageModels } from "@/lib/model-registry";
import { expandPrompt, promptIsEmpty, promptSegments, referenceImages } from "@/lib/canvas/prompt";

import { validGenerationDimensions } from "@/lib/generation/dimensions";
import { generationModels } from "@/lib/generation/client";
import type { PublicModel } from "@/lib/generation/types";
import { useGenerationTask } from "@/hooks/useGenerationTask";
import { ImageSizeSettings } from "./shared/ImageSizeSettings";
import { ImageModelSettings } from "./shared/ImageModelSettings";
import { NodeConsole } from "./shared/NodeConsole";
import { NodeConnections } from "./shared/NodeConnections";
import { PromptEditor } from "./shared/PromptEditor";
import { ImageToolbarActions } from "./shared/ImageToolbarActions";

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
  const { id, data } = props;
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const [imageModels, setImageModels] = useState<
    Array<{ value: string; label: string }>
  >([]);

  const [taskModels, setTaskModels] = useState<PublicModel[]>([]);
  const taskModel = taskModels.find(m => m.id === data.model);
  const { start: createTask, resume: resumeTask, retrySave: retrySaveTask, detach: detachTask } = useGenerationTask(id, data);
  const taskUnavailable = (data.usesGenerationTasks && !taskModel) || (!!taskModel && (!taskModel.configured || data.generationBlocked));

  const upstream = useUpstreamNodes(id);
  // Only the open console shows this, so closed nodes skip the expansion on every store change.
  const canRun = useCanvasStore((state) => !!props.selected && !promptIsEmpty(expandPrompt(id, state)));
  const segments = useMemo(() => promptSegments(data.prompt), [data.prompt]);

  // 加载图片模型列表
  useEffect(() => {
    setImageModels(getImageModels());
    let active = true;
    generationModels().then(models => { if (active) setTaskModels(models.filter(m => m.category === 'IMAGE')); }).catch(() => {});
    return () => { active = false; };
  }, []);

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
          prompt: expandPrompt(id, useCanvasStore.getState()),
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
    // Upstream content is read now, so a run always uses its current value.
    const canvas = useCanvasStore.getState();
    const promptToUse = expandPrompt(id, canvas);
    if (promptIsEmpty(promptToUse)) return;
    const references = referenceImages(id, canvas);

    if (data.usesGenerationTasks && !taskModel && !data.pendingGeneration) {
      updateNodeData(id, { error: "模型目录暂时不可用" });
      return;
    }
    if (taskModel || data.pendingGeneration) {
      if (references.length || data.inputImages?.length) {
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
          inputImages: references.length > 0 ? references : undefined,
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
    taskModel,
    detachTask,
    data.usesGenerationTasks,
    createTask,
    data.pendingGeneration,
    data.generationWidth,
    data.generationHeight,
    data.inputImages,
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

  return (
    <NodeShell {...props} stageTestId="image-preview"
      toolbar={<ImageToolbarActions src={hasResult ? data.imageSrc : undefined} alt="Generated" onSaveAsCharacter={handleSaveAsCharacter} />}
      console={
        <NodeConsole data={data} onRun={handleGenerate} runDisabled={taskUnavailable || !canRun}
          notice={taskModel && !taskModel.configured ? "请管理员配置平台连接" : undefined}
          onResume={() => void resumeTask()} onRetrySave={() => void retrySaveTask()}
          connections={<NodeConnections upstream={upstream} />}
          editor={
            <PromptEditor value={segments} upstream={upstream} placeholder="描述你想要生成的图片..."
              onChange={prompt => updateNodeData(id, { prompt })} />
          }
          config={<>
            <select
              aria-label="生图模型"
              value={data.model || imageModels[0]?.value || ""}
              disabled={data.isLoading || !!data.pendingGeneration || data.generationBlocked}
              onChange={(e) => updateNodeData(id, { model: e.target.value, usesGenerationTasks: taskModels.some(m => m.id === e.target.value) })}
              className="h-8 w-28 min-w-0 cursor-pointer truncate rounded-lg bg-transparent px-2 text-xs hover:bg-white/10 [&>option]:bg-[#232323]"
            >
              {taskModels.map(m => <option key={m.id} value={m.id}>{m.name}{m.configured ? "" : "（未配置）"}</option>)}
              {imageModels.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            {taskModel && <ImageSizeSettings width={generationWidth!} height={generationHeight!}
              limits={taskModel.capabilities.dimensions} preference={data.generationSizePreset}
              disabled={data.isLoading || !!data.pendingGeneration || data.generationBlocked}
              onChange={(size, preset) => updateNodeData(id, { generationWidth: size.width, generationHeight: size.height, generationSizePreset: preset })} />}
            {!taskModel && <ImageModelSettings aspectRatio={data.aspectRatio || '1:1'} resolution={data.resolution || '1k'}
              ratios={aspectRatios} resolutions={resolutions} disabled={data.isLoading}
              onChange={settings => updateNodeData(id, settings)} />}
            {!taskModel && (
              <button
                type="button"
                aria-label="提示词优化"
                aria-pressed={!!data.promptOptimize}
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors ${
                  data.promptOptimize ? "bg-purple-500/20 text-purple-400" : "text-zinc-400 hover:bg-white/10 hover:text-white"
                }`}
                onClick={() => updateNodeData(id, { promptOptimize: !data.promptOptimize })}
              >
                <Sparkles size={15} fill={data.promptOptimize ? "currentColor" : "none"} />
              </button>
            )}
          </>}
        />
      }
    >
      {hasResult ? (
        <img src={data.imageSrc} alt="Generated" draggable={false} className="w-full h-full object-contain" />
      ) : (
        <div role="img" aria-label="尚无生成图片" className="w-full h-full flex items-center justify-center text-zinc-500">
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center bg-zinc-800/50 text-zinc-500">
            <ImageIcon size={28} className="opacity-60" aria-hidden />
          </div>
        </div>
      )}

      {data.isLoading && (
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex flex-col items-center justify-center z-20">
          <Loader2 size={32} className="text-blue-500 animate-spin mb-3" />
          <span className="text-white/80 text-sm font-medium">{data.generationTaskId ? data.generationStatus : "生成中..."}</span>
        </div>
      )}
    </NodeShell>
  );
};

TextToImageNode.displayName = "TextToImageNode";

export default memo(TextToImageNode);
