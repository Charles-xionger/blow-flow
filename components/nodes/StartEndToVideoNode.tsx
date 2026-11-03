"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { useShallow } from "zustand/react/shallow";
import { ArrowRightLeft, Loader2, Sparkles } from "lucide-react";
import { useUpstreamNodes } from "@/hooks/useUpstreamNodes";
import { expandPrompt, promptIsEmpty, promptSegments, referenceMaterials, type PromptGraph } from "@/lib/canvas/prompt";
import { getVideoModels } from "@/lib/model-registry";
import { useCanvasStore } from "@/store/useCanvasStore";
import type { NodeData } from "@/types";
import { NodeShell } from "./NodeShell";
import { consoleSelectClass, narrowConsoleSelectClass } from "./shared/ConsoleControls";
import { NodeConnections } from "./shared/NodeConnections";
import { NodeConsole } from "./shared/NodeConsole";
import { PromptEditor } from "./shared/PromptEditor";
import { VideoStage } from "./shared/VideoStage";
import { VideoToolbarActions } from "./shared/VideoToolbarActions";

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

// The first two images in the connection layer, so frame order, numbering and what is sent always agree.
const framesOf = (nodeId: string, graph: PromptGraph) => referenceMaterials(nodeId, graph).slice(0, 2);

const StartEndToVideoNode = (props: NodeProps<Node<NodeData>>) => {
  const { id, data } = props;
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const [videoModels, setVideoModels] = useState<Array<{ value: string; label: string }>>([]);
  const [isGeneratingPrompt, setIsGeneratingPrompt] = useState(false);

  const upstream = useUpstreamNodes(id);
  // Only the open console shows these, so closed nodes skip the work on every store change.
  const imageCount = useCanvasStore((state) => props.selected ? referenceMaterials(id, state).length : 0);
  const frameSources = useCanvasStore(useShallow((state) => props.selected ? framesOf(id, state).map(frame => frame.source) : []));
  // Swapping moves whole nodes, so it only swaps the frames when each frame is its node's only image.
  const canSwap = useCanvasStore((state) => {
    if (!props.selected) return false;
    const [start, end, next] = referenceMaterials(id, state).map(material => material.source);
    return !!end && start !== end && next !== end;
  });
  const hasPrompt = useCanvasStore((state) => !!props.selected && !promptIsEmpty(expandPrompt(id, state)));
  const segments = useMemo(() => promptSegments(data.prompt), [data.prompt]);
  const hasFrames = imageCount >= 2;
  const frameTag = (index: number) => {
    const role = index ? "尾帧" : "首帧";
    const title = frameSources[index] && `图片${index + 1} · ${upstream.find(node => node.id === frameSources[index])?.name ?? ""}`;
    return (
      <span aria-label={title ? `${role}：${title}` : undefined}
        className={`rounded-md px-1.5 py-0.5 ${index ? "bg-red-500/15 text-red-300" : "bg-green-500/15 text-green-300"}`}>
        {role} {title || "未连接"}
      </span>
    );
  };

  // 加载视频模型列表 - 从数据库API异步获取
  useEffect(() => {
    let active = true;
    const loadModels = async () => {
      const builtinModels = getVideoModels();
      try {
        const response = await fetch("/api/model-config");
        const result = response.ok ? await response.json() : undefined;
        if (!result?.success || !result.data) throw new Error("模型配置不可用");
        const dbModels = Object.entries(result.data)
          .filter(([, config]: [string, any]) => config.category === "VIDEO")
          .map(([name]) => ({ value: name, label: name }));
        const allModels = [...dbModels, ...builtinModels];
        if (active) setVideoModels(allModels.filter((model, index) => index === allModels.findIndex(m => m.value === model.value)));
      } catch (error) {
        console.error("[StartEndToVideoNode] Failed to load models:", error);
        if (active) setVideoModels(builtinModels);
      }
    };
    void loadModels();
    return () => { active = false; };
  }, []);

  // Swapping reorders the connections, so the numbers in the prompt follow the frames.
  const swapFrames = () => {
    const [start, end] = frameSources;
    const order = upstream.map(node => node.id === start ? end : node.id === end ? start : node.id);
    useCanvasStore.getState().reorderUpstream(id, order);
  };

  const handleGeneratePrompt = useCallback(async () => {
    const canvas = useCanvasStore.getState();
    const [startImage, endImage] = framesOf(id, canvas).map(frame => frame.src);
    if (!endImage) return;

    setIsGeneratingPrompt(true);
    try {
      const response = await fetch("/api/generate-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeType: "startEndToVideo",
          currentPrompt: expandPrompt(id, canvas),
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
      if (result.success && result.data) {
        updateNodeData(id, { prompt: result.data });
      } else {
        throw new Error(result.error || "生成提示词失败");
      }
    } catch (error) {
      console.error("[StartEndToVideoNode] Prompt generation error:", error);
      updateNodeData(id, { error: error instanceof Error ? error.message : "生成提示词失败" });
    } finally {
      setIsGeneratingPrompt(false);
    }
  }, [id, data.duration, data.resolution, data.aspectRatio, data.model, updateNodeData]);

  const handleGenerate = useCallback(async () => {
    // Upstream content is read now, so a run always uses its current value.
    const canvas = useCanvasStore.getState();
    const prompt = expandPrompt(id, canvas);
    const frames = framesOf(id, canvas).map(frame => frame.src);
    const [startImage, endImage] = frames;
    if (promptIsEmpty(prompt) || !endImage) return;

    updateNodeData(id, { isLoading: true, error: undefined });
    try {
      const response = await fetch("/api/generate/start-end-to-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          startImage,
          endImage,
          model: data.model || videoModels[0]?.value || "wan2.2-kf2v-flash-首尾帧生成视频模型",
          duration: parseInt(data.duration || "5"),
          resolution: data.resolution || "720P",
          aspectRatio: data.aspectRatio || "16:9",
          promptOptimize: data.promptOptimize || false,
        }),
      });

      const result = await response.json();
      if (result.success && result.data) {
        updateNodeData(id, { isLoading: false, videoSrc: result.data, inputImages: frames });
      } else {
        throw new Error(result.error || "生成失败");
      }
    } catch (error) {
      console.error("[StartEndToVideoNode] Generation error:", error);
      updateNodeData(id, { isLoading: false, error: error instanceof Error ? error.message : "生成失败" });
    }
  }, [id, data.model, data.duration, data.resolution, data.aspectRatio, data.promptOptimize, updateNodeData, videoModels]);

  const promptAction = hasPrompt ? "优化提示词" : "AI 生成提示词";

  return (
    <NodeShell {...props} stageTestId="video-preview"
      toolbar={<VideoToolbarActions src={data.isLoading ? undefined : data.videoSrc} />}
      console={
        <NodeConsole data={data} onRun={() => void handleGenerate()} runDisabled={!hasFrames || !hasPrompt}
          notice={!hasFrames ? `请连接两个图片节点作为首尾帧（当前 ${imageCount}/2）` : imageCount > 2 ? "只使用连接层的前两张图片作为首尾帧" : undefined}
          connections={upstream.length > 0 && (
            <div className="flex flex-col gap-2">
              <NodeConnections nodeId={id} upstream={upstream} />
              <div className="flex items-center gap-2 text-xs text-zinc-400">
                {frameTag(0)}
                <button type="button" aria-label="交换首尾帧" title="交换首尾帧" onClick={swapFrames}
                  disabled={data.isLoading || !canSwap}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/10 hover:text-white disabled:pointer-events-none disabled:opacity-30">
                  <ArrowRightLeft size={12} />
                </button>
                {frameTag(1)}
              </div>
            </div>
          )}
          editor={
            <PromptEditor value={segments} upstream={upstream} placeholder="描述你想要的视频内容..."
              onChange={prompt => updateNodeData(id, { prompt })} />
          }
          config={<>
            <select aria-label="视频模型" value={data.model || videoModels[0]?.value || ""} className={consoleSelectClass}
              onChange={event => updateNodeData(id, { model: event.target.value })}>
              {videoModels.map(model => <option key={model.value} value={model.value}>{model.label}</option>)}
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
            <button type="button" aria-label={promptAction} title={promptAction} disabled={isGeneratingPrompt || !hasFrames}
              onClick={() => void handleGeneratePrompt()}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-white/10 hover:text-white disabled:pointer-events-none disabled:opacity-30">
              {isGeneratingPrompt ? <Loader2 className="animate-spin" size={15} /> : <Sparkles size={15} />}
            </button>
          </>}
        />
      }
    >
      <VideoStage data={data} emptyLabel="首尾帧生视频" />
    </NodeShell>
  );
};

StartEndToVideoNode.displayName = "StartEndToVideoNode";

export default memo(StartEndToVideoNode);
