"use client";

import { memo, useCallback, useMemo } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { Film, Loader2, Minus, Plus } from "lucide-react";
import { promptIsEmpty, promptSegments, promptText } from "@/lib/canvas/prompt";
import { getModelsByCategory } from "@/lib/model-registry";
import { useCanvasStore } from "@/store/useCanvasStore";
import { NodeType, type NodeData } from "@/types";
import { NodeShell } from "./NodeShell";
import { consoleSelectClass } from "./shared/ConsoleControls";
import { NodeConsole } from "./shared/NodeConsole";
import { PromptEditor } from "./shared/PromptEditor";

const minShots = 2;
const maxShots = 8;
const stepButtonClass = "flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-white/10 hover:text-white disabled:pointer-events-none disabled:opacity-30";

const CreativeDescNode = (props: NodeProps<Node<NodeData>>) => {
  const { id, data } = props;
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addMultipleConnectedNodes = useCanvasStore((state) => state.addMultipleConnectedNodes);
  const textModels = useMemo(() => getModelsByCategory("TEXT"), []);
  const segments = useMemo(() => promptSegments(data.prompt), [data.prompt]);
  const shotCount = Math.min(maxShots, Math.max(minShots, data.shotCount || 4));

  const handleGenerateStoryboard = useCallback(async () => {
    // This node has no inputs, so its prompt holds no references.
    const prompt = promptText(data.prompt);
    if (promptIsEmpty(prompt)) return;

    updateNodeData(id, { isLoading: true, error: undefined });

    try {
      const nodePosition = useCanvasStore.getState().nodes.find((node) => node.id === id)?.position ?? { x: 0, y: 0 };
      const response = await fetch("/api/storyboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, shotCount, modelName: data.model || "" }),
      });

      const result = await response.json();

      if (result.success && result.data) {
        updateNodeData(id, { isLoading: false, storyboardShots: result.data, shotCount });

        // 自动创建文本节点
        const nodesToCreate = result.data.map((shot: { title: string; description: string }) => ({
          type: NodeType.TEXT,
          data: { prompt: [{ text: shot.description }], customTitle: shot.title },
        }));
        addMultipleConnectedNodes(nodesToCreate, id, { x: nodePosition.x + 400, y: nodePosition.y - 150 });
      } else {
        const errorMsg = result.error || "分镜生成失败";
        throw new Error(
          errorMsg.includes("No text model configured")
            ? "请先在设置中配置文本模型（如 Gemini 2.5 Pro）"
            : errorMsg,
        );
      }
    } catch (error) {
      updateNodeData(id, {
        isLoading: false,
        error: error instanceof Error ? error.message : "分镜生成失败",
      });
    }
  }, [id, data.prompt, data.model, shotCount, updateNodeData, addMultipleConnectedNodes]);

  const successCount = data.storyboardShots?.length || 0;
  const hasResult = !!data.storyboardShots && !data.isLoading;

  return (
    <NodeShell {...props}
      console={
        <NodeConsole data={data} onRun={() => void handleGenerateStoryboard()} runDisabled={promptIsEmpty(data.prompt)}
          editor={
            <PromptEditor value={segments} upstream={[]} placeholder="输入故事或场景描述，例如：一个关于勇士冒险的故事..."
              onChange={prompt => updateNodeData(id, { prompt })} />
          }
          config={<>
            <select aria-label="文本模型" value={data.model || ""} className={consoleSelectClass}
              onChange={event => updateNodeData(id, { model: event.target.value })}>
              <option value="">自动选择</option>
              {textModels.map(model => <option key={model.id} value={model.name}>{model.name}</option>)}
            </select>
            <span className="ml-1 text-xs text-zinc-400">镜头</span>
            <button type="button" aria-label="减少镜头" title="减少镜头" disabled={shotCount <= minShots} className={stepButtonClass}
              onClick={() => updateNodeData(id, { shotCount: shotCount - 1 })}>
              <Minus size={14} />
            </button>
            <span aria-label="镜头数量" className="w-6 text-center text-xs font-semibold text-white">{shotCount}</span>
            <button type="button" aria-label="增加镜头" title="增加镜头" disabled={shotCount >= maxShots} className={stepButtonClass}
              onClick={() => updateNodeData(id, { shotCount: shotCount + 1 })}>
              <Plus size={14} />
            </button>
          </>}
        />
      }
    >
      <div className="relative flex h-full w-full flex-col items-center justify-center p-6">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-zinc-800/50 text-purple-500">
          <Film size={28} className="opacity-60" />
        </div>
        <div className="mb-1 text-sm font-medium text-zinc-300">AI 分镜生成器</div>
        {hasResult ? (
          <div className="flex items-center gap-1 text-xs text-purple-400">
            <span>✓ 已生成 {successCount} 个文本节点</span>
          </div>
        ) : (
          <div className="text-xs text-zinc-500">输入故事描述开始生成</div>
        )}
      </div>

      {data.isLoading && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/60 backdrop-blur-sm">
          <Loader2 size={32} className="mb-3 animate-spin text-purple-500" />
          <span className="text-sm font-medium text-white/80">分镜生成中...</span>
        </div>
      )}
    </NodeShell>
  );
};

CreativeDescNode.displayName = "CreativeDescNode";

export default memo(CreativeDescNode);
