"use client";

import { nodeContentEqual } from "@/lib/canvas/node-content";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { Loader2, Sparkles } from "lucide-react";
import { useGenerationTask } from "@/hooks/useGenerationTask";
import { useUpstreamNodes } from "@/hooks/useUpstreamNodes";
import { expandPrompt, promptIsEmpty, promptSegments, referenceImages } from "@/lib/canvas/prompt";
import { generationModels } from "@/lib/generation/client";
import type { PublicModel } from "@/lib/generation/types";
import { getVideoModels } from "@/lib/model-registry";
import { useCanvasStore } from "@/store/useCanvasStore";
import type { NodeData } from "@/types";
import { NodeShell } from "./NodeShell";
import { consoleSelectClass, narrowConsoleSelectClass } from "./shared/ConsoleControls";
import { NodeConnections } from "./shared/NodeConnections";
import { NodeConsole } from "./shared/NodeConsole";
import { PromptEditor } from "./shared/PromptEditor";
import { TaskVideoNode } from "./shared/TaskVideoNode";
import { VideoStage } from "./shared/VideoStage";
import { VideoToolbarActions } from "./shared/VideoToolbarActions";

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
  const { id, data } = props;
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const task = useGenerationTask(id, data);
  const [taskModels, setTaskModels] = useState<PublicModel[]>([]);
  const taskModel = taskModels.find(m => m.id === data.model);
  const [videoModels, setVideoModels] = useState<Array<{ id: string; value: string; label: string }>>([]);
  const [isGeneratingPrompt, setIsGeneratingPrompt] = useState(false);

  const upstream = useUpstreamNodes(id);
  // Only the open console shows these, so closed nodes skip the work on every store change.
  const inputCount = useCanvasStore((state) => props.selected ? referenceImages(id, state).length : 0);
  const hasInput = inputCount > 0;
  const hasPrompt = useCanvasStore((state) => !!props.selected && !promptIsEmpty(expandPrompt(id, state)));
  const segments = useMemo(() => promptSegments(data.prompt), [data.prompt]);

  // 加载视频模型列表
  useEffect(() => {
    setVideoModels(getVideoModels());
    let active = true;
    generationModels().then(models => { if (active) setTaskModels(models.filter(m => m.category === 'VIDEO')); }).catch(() => {});
    return () => { active = false; };
  }, []);

  const handleGeneratePrompt = useCallback(async () => {
    const canvas = useCanvasStore.getState();
    const [inputImage] = referenceImages(id, canvas);
    if (!inputImage) return;

    setIsGeneratingPrompt(true);

    try {
      const response = await fetch("/api/generate-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeType: "imageToVideo",
          currentPrompt: expandPrompt(id, canvas) || undefined,
          context: {
            inputImage,
            duration: data.duration || "5",
            model: data.model,
          },
        }),
      });

      const result = await response.json();

      if (result.success && result.data) {
        updateNodeData(id, { prompt: promptSegments(result.data) });
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
  }, [id, data.duration, data.model, updateNodeData]);

  const handleGenerate = useCallback(async () => {
    // Upstream content is read now, so a run always uses its current value.
    const canvas = useCanvasStore.getState();
    const prompt = expandPrompt(id, canvas);
    // This API takes one image: the first in the connection layer.
    const [inputImage] = referenceImages(id, canvas);
    if (promptIsEmpty(prompt) || !inputImage) return;

    const complete = useCanvasStore.getState().beginMediaOperation(id);
    try {
      await task.detach();
      const response = await fetch("/api/generate/image-to-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          inputImage,
          model: data.model || "wan2.6-i2v-flash",
          duration: parseInt(data.duration || "5"),
          resolution: data.resolution || "720P",
          aspectRatio: data.aspectRatio || "16:9",
          promptOptimize: data.promptOptimize || false,
          skipCache: false,
        }),
      });

      const result = await response.json();

      if (result.success && result.data) {
        complete({
          isLoading: false,
          videoSrc: result.data,
          inputImages: [inputImage],
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
  }, [id, data.model, data.duration, data.resolution, data.aspectRatio, data.promptOptimize, task]);

  const modelOptions = [
    ...taskModels.map(m => ({ id: m.id, label: m.name + (m.configured ? '' : '（未配置）'), task: true })),
    ...videoModels.map(m => ({ id: m.id, label: m.label })),
  ];
  if (data.model && !modelOptions.some(m => m.id === data.model)) modelOptions.push({ id: data.model, label: data.model });
  if (taskModel || data.usesGenerationTasks || data.model === 'runninghub-h3')
    return <TaskVideoNode node={props} model={taskModel} models={modelOptions} task={task} />;

  const promptAction = hasPrompt ? "优化提示词" : "AI 生成提示词";

  return (
    <NodeShell {...props} stageTestId="video-preview"
      toolbar={<VideoToolbarActions src={data.isLoading ? undefined : data.videoSrc} />}
      console={
        <NodeConsole data={data} onRun={() => void handleGenerate()} runDisabled={!hasInput || !hasPrompt}
          notice={!hasInput ? "请连接一个图片节点作为输入" : inputCount > 1 ? "此模型只使用连接层的第一张图片" : undefined}
          onResume={() => void task.resume()} onRetrySave={() => void task.retrySave()}
          connections={<NodeConnections nodeId={id} upstream={upstream} />}
          editor={
            <PromptEditor value={segments} upstream={upstream} placeholder="描述你想要的视频内容..."
              onChange={prompt => updateNodeData(id, { prompt })} />
          }
          config={<>
            <select aria-label="视频模型" value={data.model || videoModels[0]?.id || ""} className={consoleSelectClass}
              onChange={event => updateNodeData(id, { model: event.target.value, usesGenerationTasks: taskModels.some(m => m.id === event.target.value) })}>
              {modelOptions.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
            </select>
            <select aria-label="视频时长" value={data.duration || "5"} className={narrowConsoleSelectClass}
              onChange={event => updateNodeData(id, { duration: event.target.value })}>
              {durations.map(duration => <option key={duration.value} value={duration.value}>{duration.label}</option>)}
            </select>
            <select aria-label="视频分辨率" value={data.resolution || "720P"} className={narrowConsoleSelectClass}
              onChange={event => updateNodeData(id, { resolution: event.target.value })}>
              {resolutions.map(resolution => <option key={resolution.value} value={resolution.value}>{resolution.label}</option>)}
            </select>
            <select aria-label="视频画幅" value={data.aspectRatio || "16:9"} className={narrowConsoleSelectClass}
              onChange={event => updateNodeData(id, { aspectRatio: event.target.value })}>
              {aspectRatios.map(ratio => <option key={ratio.value} value={ratio.value}>{ratio.label}</option>)}
            </select>
            <button type="button" aria-label={promptAction} title={promptAction} disabled={isGeneratingPrompt || !hasInput}
              onClick={() => void handleGeneratePrompt()}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-white/10 hover:text-white disabled:pointer-events-none disabled:opacity-30">
              {isGeneratingPrompt ? <Loader2 className="animate-spin" size={15} /> : <Sparkles size={15} />}
            </button>
          </>}
        />
      }
    >
      <VideoStage data={data} emptyLabel="图生视频" />
    </NodeShell>
  );
};

ImageToVideoNode.displayName = "ImageToVideoNode";

export default memo(ImageToVideoNode, nodeContentEqual);
