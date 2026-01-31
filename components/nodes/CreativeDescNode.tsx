"use client";

import { memo, useCallback, useState, useEffect, useMemo } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { Handle, Position } from "@xyflow/react";
import { useCanvasStore } from "@/store/useCanvasStore";
import { Film, Loader2, Wand2, Plus, Minus } from "lucide-react";
import type { NodeData, NodeType } from "@/types";
import { EditableTitle } from "./shared/EditableTitle";
import { QuickAddNode } from "../canvas/QuickAddNode";
import { Textarea } from "@/components/ui/textarea";
import { getModelsByCategory } from "@/lib/model-registry";

const CreativeDescNode = ({
  id,
  data,
  selected,
}: NodeProps<Node<NodeData>>) => {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addMultipleConnectedNodes = useCanvasStore(
    (state) => state.addMultipleConnectedNodes,
  );
  const nodes = useCanvasStore((state) => state.nodes);
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds);
  const currentNode = nodes.find((n) => n.id === id);
  const nodePosition = useMemo(
    () => currentNode?.position || { x: 0, y: 0 },
    [currentNode?.position],
  );

  const shouldShowPanel = selected && selectedNodeIds.length === 1;
  const [localPrompt, setLocalPrompt] = useState(data.prompt || "");
  const [shotCount, setShotCount] = useState(data.shotCount || 4);
  const [selectedModel, setSelectedModel] = useState(data.model || "");

  // 获取可用的文本模型
  const textModels = useMemo(() => getModelsByCategory("TEXT"), []);

  useEffect(() => {
    setLocalPrompt(data.prompt || "");
  }, [data.prompt]);

  const handleGenerateStoryboard = useCallback(async () => {
    if (localPrompt !== data.prompt) {
      updateNodeData(id, { prompt: localPrompt });
    }

    if (!localPrompt) return;

    updateNodeData(id, { isLoading: true, error: undefined });

    try {
      const response = await fetch("/api/storyboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: localPrompt,
          shotCount,
          modelName: selectedModel,
        }),
      });

      const result = await response.json();

      if (result.success && result.data) {
        updateNodeData(id, {
          isLoading: false,
          storyboardShots: result.data,
          shotCount,
        });

        // 自动创建文本节点
        const nodesToCreate = result.data.map((shot: any) => ({
          type: "text" as NodeType,
          data: {
            prompt: shot.description,
            customTitle: shot.title,
          },
        }));

        const startPosition = {
          x: nodePosition.x + 400,
          y: nodePosition.y - 150,
        };

        addMultipleConnectedNodes(nodesToCreate, id, startPosition);
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
  }, [
    id,
    localPrompt,
    shotCount,
    selectedModel,
    updateNodeData,
    data.prompt,
    nodePosition,
    addMultipleConnectedNodes,
  ]);

  const successCount = data.storyboardShots?.length || 0;
  const hasResult = !!data.storyboardShots && !data.isLoading;

  return (
    <>
      <EditableTitle
        nodeId={id}
        defaultTitle="AI 分镜师"
        customTitle={data.customTitle}
      />

      <div className="absolute right-0 top-1/2 -translate-y-1/2 flex items-center">
        <QuickAddNode nodeId={id} nodePosition={nodePosition} />
        <Handle type="source" position={Position.Right} id="output" />
      </div>

      <div
        style={{ width: "320px", height: "200px" }}
        className={`relative rounded-2xl border ${
          selected
            ? "border-purple-500 ring-2 ring-purple-500/30"
            : "border-zinc-700/50"
        } bg-[#1a1a1a] overflow-hidden shadow-xl group transition-all duration-200`}
      >
        <div className="relative w-full h-full p-6 flex flex-col items-center justify-center">
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4 bg-zinc-800/50 text-purple-500">
            <Film size={28} className="opacity-60" />
          </div>
          <div className="text-sm font-medium text-zinc-300 mb-1">
            AI 分镜生成器
          </div>
          {hasResult ? (
            <div className="text-xs text-purple-400 flex items-center gap-1">
              <span>✓ 已生成 {successCount} 个文本节点</span>
            </div>
          ) : (
            <div className="text-xs text-zinc-500">输入故事描述开始生成</div>
          )}
        </div>

        {data.isLoading && (
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex flex-col items-center justify-center z-20">
            <Loader2 size={32} className="text-purple-500 animate-spin mb-3" />
            <span className="text-white/80 text-sm font-medium">
              分镜生成中...
            </span>
          </div>
        )}
      </div>

      {shouldShowPanel && (
        <div
          className="absolute top-full left-1/2 -translate-x-1/2 min-w-100 pt-4 z-70 pointer-events-auto"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="bg-[#1a1a1a]/95 backdrop-blur-xl border border-zinc-700/50 rounded-2xl p-4 flex flex-col gap-3">
            {/* 模型选择 */}
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium text-zinc-400">
                选择模型
              </label>
              <select
                value={selectedModel}
                onChange={(e) => {
                  setSelectedModel(e.target.value);
                  updateNodeData(id, { model: e.target.value });
                }}
                className="nodrag w-full px-3 py-2 text-sm rounded-lg bg-zinc-800/80 hover:bg-zinc-800 border border-zinc-700 focus:border-purple-500 text-white transition-colors"
                onMouseDown={(e) => e.stopPropagation()}
              >
                <option value="">自动选择</option>
                {textModels.map((model) => (
                  <option key={model.id} value={model.name}>
                    {model.name}
                  </option>
                ))}
              </select>
            </div>

            <Textarea
              className="nodrag w-full border rounded-xl px-4 py-3 text-sm leading-relaxed resize-none min-h-24 bg-zinc-800/80 hover:bg-zinc-800 border-zinc-700 focus:border-purple-500 text-white placeholder-zinc-500"
              placeholder="输入故事或场景描述，例如：一个关于勇士冒险的故事..."
              value={localPrompt}
              onChange={(e) => setLocalPrompt(e.target.value)}
              onBlur={() => updateNodeData(id, { prompt: localPrompt })}
              onMouseDown={(e) => e.stopPropagation()}
              onWheel={(e) => e.stopPropagation()}
              rows={4}
            />

            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 text-sm text-zinc-400">
                <span>镜头数量：</span>
                <button
                  onClick={() => setShotCount(Math.max(2, shotCount - 1))}
                  className="w-7 h-7 rounded flex items-center justify-center bg-zinc-800 hover:bg-zinc-700 transition-colors"
                >
                  <Minus size={14} />
                </button>
                <span className="w-8 text-center text-white font-semibold">
                  {shotCount}
                </span>
                <button
                  onClick={() => setShotCount(Math.min(8, shotCount + 1))}
                  className="w-7 h-7 rounded flex items-center justify-center bg-zinc-800 hover:bg-zinc-700 transition-colors"
                >
                  <Plus size={14} />
                </button>
              </div>
            </div>

            <button
              onClick={handleGenerateStoryboard}
              disabled={data.isLoading || !localPrompt}
              className={`w-full h-10 px-4 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 whitespace-nowrap transition-all active:scale-[0.98] ${
                data.isLoading || !localPrompt
                  ? "bg-gray-400 text-white cursor-not-allowed"
                  : "bg-linear-to-r from-purple-600 to-purple-500 hover:from-purple-500 hover:to-purple-400 text-white shadow-lg shadow-purple-500/25 hover:shadow-purple-500/40"
              }`}
            >
              {data.isLoading ? (
                <Loader2 className="animate-spin" size={15} />
              ) : (
                <Wand2 size={15} />
              )}
              <span>{data.isLoading ? "生成中" : "生成分镜"}</span>
            </button>

            {data.error && (
              <div className="text-xs text-red-400 bg-red-500/10 px-3 py-2 rounded-lg border border-red-500/20">
                {data.error}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
};

CreativeDescNode.displayName = "CreativeDescNode";

export default memo(CreativeDescNode);
