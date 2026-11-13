"use client";

import { ImageGenerationRouter } from "./shared/ImageGenerationRouter";

import { nodeContentEqual } from "@/lib/canvas/node-content";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { RefreshCw } from "lucide-react";
import { useUpstreamNodes } from "@/hooks/useUpstreamNodes";
import { expandPrompt, promptIsEmpty, promptSegments, referenceImages } from "@/lib/canvas/prompt";
import { supportsImageNodeModel, imageModelSelection } from "@/lib/generation/image-models";
import { generationModels } from "@/lib/generation/client";
import type { PublicModel } from "@/lib/generation/types";
import { getImageModels } from "@/lib/model-registry";
import { useCanvasStore } from "@/store/useCanvasStore";
import type { NodeData } from "@/types";
import { NodeShell } from "./NodeShell";
import { PromptOptimizeToggle, consoleSelectClass } from "./shared/ConsoleControls";
import { ImageModelSettings } from "./shared/ImageModelSettings";
import { ImageStage } from "./shared/ImageStage";
import { ImageToolbarActions } from "./shared/ImageToolbarActions";
import { NodeConnections } from "./shared/NodeConnections";
import { NodeConsole } from "./shared/NodeConsole";
import { PromptEditor } from "./shared/PromptEditor";

const aspectRatios = [
  { value: "1:1", label: "1:1 方形" },
  { value: "16:9", label: "16:9 横屏" },
  { value: "9:16", label: "9:16 竖屏" },
];

const resolutions = [
  { value: "1024x1024", label: "1K" },
  { value: "2048x2048", label: "2K" },
  { value: "4096x4096", label: "4K" },
];

const ImageToImageNode = (props: NodeProps<Node<NodeData>>) => {
  const { id, data } = props;
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const [imageModels, setImageModels] = useState<Array<{ value: string; label: string }>>([]);

  const [taskModels, setTaskModels] = useState<PublicModel[]>([]);
  const upstream = useUpstreamNodes(id);
  const hasInput = useCanvasStore((state) => !!props.selected && referenceImages(id, state).length > 0);
  // Only the open console shows this, so closed nodes skip the expansion on every store change.
  const hasPrompt = useCanvasStore((state) => !!props.selected && !promptIsEmpty(expandPrompt(id, state)));
  const segments = useMemo(() => promptSegments(data.prompt), [data.prompt]);

  // 加载图片模型列表
  useEffect(() => {
    setImageModels(getImageModels());
    let active = true;
    generationModels().then(models => { if (active) setTaskModels(models.filter(model => supportsImageNodeModel(model, 'imageToImage'))); }).catch(() => {});
    return () => { active = false; };
  }, []);

  const handleGenerate = useCallback(async (skipCache = false) => {
    if (data.usesGenerationTasks) return;
    // Upstream content is read now, so a run always uses its current value.
    const canvas = useCanvasStore.getState();
    const prompt = expandPrompt(id, canvas);
    const inputImages = referenceImages(id, canvas);
    if (promptIsEmpty(prompt) || !inputImages.length) return;

    const complete = useCanvasStore.getState().beginMediaOperation(id);

    try {
      const response = await fetch("/api/generate/image-to-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          inputImage: inputImages[0], // 保持第一张作为主输入（兼容性）
          inputImages, // 传递所有输入图片
          model: data.model || "BananaPro",
          aspectRatio: data.aspectRatio || "1:1",
          resolution: data.resolution || "1024x1024", // 传递分辨率参数
          promptOptimize: data.promptOptimize || false,
          skipCache, // 传递 skipCache 参数
        }),
      });

      const result = await response.json();

      if (result.success && result.data) {
        complete({
          isLoading: false,
          imageSrc: result.data,
          inputImages: [inputImages[0]],
        });
      } else {
        throw new Error(result.error || "生成失败");
      }
    } catch (error) {
      complete({
        isLoading: false,
        error: error instanceof Error ? error.message : "生成失败",
      });
    }
  }, [id, data.usesGenerationTasks, data.model, data.aspectRatio, data.resolution, data.promptOptimize]);

  const hasResult = !!data.imageSrc && !data.isLoading;

  return (
    <NodeShell {...props} stageTestId="image-preview"
      toolbar={<ImageToolbarActions nodeId={id} src={hasResult ? data.imageSrc : undefined} alt="Generated" />}
      console={
        <NodeConsole data={data} onRun={() => void handleGenerate()} runDisabled={!!data.usesGenerationTasks || !hasInput || !hasPrompt}
          notice={hasInput ? undefined : "请连接图片节点（支持多张图片参考）"}
          connections={<NodeConnections nodeId={id} upstream={upstream} />}
          editor={
            <PromptEditor value={segments} upstream={upstream} placeholder="描述你想要的变化..."
              onChange={prompt => updateNodeData(id, { prompt })} />
          }
          config={<>
            <select aria-label="生图模型" value={data.model || imageModels[0]?.value || ""} disabled={data.isLoading}
              onChange={event => updateNodeData(id, imageModelSelection(event.target.value, taskModels, data.aspectRatio))} className={consoleSelectClass}>
              {taskModels.map(model => <option key={model.id} value={model.id}>{model.name}{model.configured ? "" : "（未配置）"}</option>)}
              {imageModels.map(model => <option key={model.value} value={model.value}>{model.label}</option>)}
            </select>
            <ImageModelSettings aspectRatio={data.aspectRatio || "1:1"} resolution={data.resolution || "1024x1024"}
              ratios={aspectRatios} resolutions={resolutions} disabled={data.isLoading}
              onChange={settings => updateNodeData(id, settings)} />
            <PromptOptimizeToggle active={!!data.promptOptimize} onChange={promptOptimize => updateNodeData(id, { promptOptimize })} />
            {hasResult && (
              <button type="button" aria-label="重新生成（跳过缓存）" title="重新生成（跳过缓存）" disabled={!hasInput || !hasPrompt}
                onClick={() => void handleGenerate(true)}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-white/10 hover:text-white disabled:pointer-events-none disabled:opacity-30">
                <RefreshCw size={15} />
              </button>
            )}
          </>}
        />
      }
    >
      <ImageStage data={data} />
    </NodeShell>
  );
};

ImageToImageNode.displayName = "ImageToImageNode";

const RoutedImageToImageNode = (props: NodeProps<Node<NodeData>>) => <ImageGenerationRouter {...props} legacy={ImageToImageNode} />;
export default memo(RoutedImageToImageNode, nodeContentEqual);
