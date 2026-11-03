"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { useUpstreamNodes } from "@/hooks/useUpstreamNodes";
import { expandPrompt, promptIsEmpty, promptSegments } from "@/lib/canvas/prompt";
import { getVideoModels } from "@/lib/model-registry";
import { useCanvasStore } from "@/store/useCanvasStore";
import type { NodeData } from "@/types";
import { NodeShell } from "./NodeShell";
import { PromptOptimizeToggle, consoleSelectClass, narrowConsoleSelectClass } from "./shared/ConsoleControls";
import { NodeConnections } from "./shared/NodeConnections";
import { NodeConsole } from "./shared/NodeConsole";
import { PromptEditor } from "./shared/PromptEditor";
import { VideoStage } from "./shared/VideoStage";
import { VideoToolbarActions } from "./shared/VideoToolbarActions";

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

const TextToVideoNode = (props: NodeProps<Node<NodeData>>) => {
  const { id, data } = props;
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const [videoModels, setVideoModels] = useState<Array<{ value: string; label: string }>>([]);

  const upstream = useUpstreamNodes(id);
  // Only the open console shows this, so closed nodes skip the expansion on every store change.
  const canRun = useCanvasStore((state) => !!props.selected && !promptIsEmpty(expandPrompt(id, state)));
  const segments = useMemo(() => promptSegments(data.prompt), [data.prompt]);

  // 加载视频模型列表
  useEffect(() => {
    setVideoModels(getVideoModels());
  }, []);

  const handleGenerate = useCallback(async () => {
    // Upstream content is read now, so a run always uses its current value.
    const prompt = expandPrompt(id, useCanvasStore.getState());
    if (promptIsEmpty(prompt)) return;

    updateNodeData(id, { isLoading: true, error: undefined });

    try {
      const response = await fetch("/api/generate/video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          model: data.model || "Sora 2",
          aspectRatio: data.aspectRatio || "16:9",
          duration: data.duration || "5s",
          promptOptimize: data.promptOptimize || false,
          skipCache: false,
        }),
      });

      const result = await response.json();

      if (result.success && result.data) {
        updateNodeData(id, { isLoading: false, videoSrc: result.data });
      } else {
        throw new Error(result.error || "生成失败");
      }
    } catch (error) {
      updateNodeData(id, {
        isLoading: false,
        error: error instanceof Error ? error.message : "生成失败",
      });
    }
  }, [id, data.model, data.aspectRatio, data.duration, data.promptOptimize, updateNodeData]);

  return (
    <NodeShell {...props} stageTestId="video-preview"
      toolbar={<VideoToolbarActions src={data.isLoading ? undefined : data.videoSrc} />}
      console={
        <NodeConsole data={data} onRun={() => void handleGenerate()} runDisabled={!canRun}
          connections={<NodeConnections nodeId={id} upstream={upstream} />}
          editor={
            <PromptEditor value={segments} upstream={upstream} placeholder="描述你想要生成的视频..."
              onChange={prompt => updateNodeData(id, { prompt })} />
          }
          config={<>
            <select aria-label="视频模型" value={data.model || videoModels[0]?.value || ""}
              onChange={event => updateNodeData(id, { model: event.target.value })} className={consoleSelectClass}>
              {videoModels.map(model => <option key={model.value} value={model.value}>{model.label}</option>)}
            </select>
            <select aria-label="视频时长" value={data.duration || "5s"}
              onChange={event => updateNodeData(id, { duration: event.target.value })} className={narrowConsoleSelectClass}>
              {durations.map(duration => <option key={duration.value} value={duration.value}>{duration.label}</option>)}
            </select>
            <select aria-label="视频画幅" value={data.aspectRatio || "16:9"}
              onChange={event => updateNodeData(id, { aspectRatio: event.target.value })} className={narrowConsoleSelectClass}>
              {aspectRatios.map(ratio => <option key={ratio.value} value={ratio.value}>{ratio.label}</option>)}
            </select>
            <PromptOptimizeToggle active={!!data.promptOptimize} onChange={promptOptimize => updateNodeData(id, { promptOptimize })} />
          </>}
        />
      }
    >
      <VideoStage data={data} emptyLabel="生视频" />
    </NodeShell>
  );
};

TextToVideoNode.displayName = "TextToVideoNode";

export default memo(TextToVideoNode);
