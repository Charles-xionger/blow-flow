"use client";

import { memo, useCallback, useState, useEffect } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { Handle, Position } from "@xyflow/react";
import { useCanvasStore } from "@/store/useCanvasStore";
import { FileText } from "lucide-react";
import type { NodeData } from "@/types";
import { EditableTitle } from "./shared/EditableTitle";
import { QuickAddNode } from "../canvas/QuickAddNode";
import { Textarea } from "@/components/ui/textarea";

const TextNode = ({ id, data, selected }: NodeProps<Node<NodeData>>) => {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const nodes = useCanvasStore((state) => state.nodes);
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds);
  const currentNode = nodes.find((n) => n.id === id);
  const nodePosition = currentNode?.position || { x: 0, y: 0 };

  const shouldShowPanel = selected && selectedNodeIds.length === 1;
  const [localPrompt, setLocalPrompt] = useState(data.prompt || "");

  // 使用 key 或者不在 effect 中设置状态，而是在渲染时检查
  useEffect(() => {
    // 使用 setTimeout 将 setState 推迟到下一个事件循环，避免同步调用
    const timer = setTimeout(() => {
      if (data.prompt !== localPrompt) {
        setLocalPrompt(data.prompt || "");
      }
    }, 0);

    return () => clearTimeout(timer);
  }, [data.prompt]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleBlur = useCallback(() => {
    if (localPrompt !== data.prompt) {
      updateNodeData(id, { prompt: localPrompt });
    }
  }, [id, localPrompt, data.prompt, updateNodeData]);

  return (
    <>
      <EditableTitle
        nodeId={id}
        defaultTitle="文本描述"
        customTitle={data.customTitle}
      />

      <Handle type="target" position={Position.Left} id="input" />

      <div className="absolute right-0 top-1/2 -translate-y-1/2 flex items-center">
        <QuickAddNode nodeId={id} nodePosition={nodePosition} />
        <Handle type="source" position={Position.Right} id="output" />
      </div>

      <div
        style={{ width: "320px", height: "240px" }}
        className={`relative rounded-2xl border ${
          selected
            ? "border-purple-500 ring-2 ring-purple-500/30"
            : "border-zinc-700/50"
        } bg-[#1a1a1a] overflow-hidden shadow-xl group transition-all duration-200`}
      >
        <div className="relative w-full h-full p-4">
          <div className="w-full h-full flex flex-col items-center justify-center text-zinc-400">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4 bg-zinc-800/50 text-purple-500">
              <FileText size={28} className="opacity-60" />
            </div>
            <div className="text-sm font-medium opacity-60 mb-2">文本描述</div>
            <div className="text-xs text-zinc-500 text-center px-4 max-h-32 overflow-y-auto">
              {data.prompt || "暂无内容"}
            </div>
          </div>
        </div>
      </div>

      {shouldShowPanel && (
        <div
          className="absolute top-full left-1/2 -translate-x-1/2 min-w-100 pt-4 z-70 pointer-events-auto"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="bg-[#1a1a1a]/95 backdrop-blur-xl border border-zinc-700/50 rounded-2xl p-4 flex flex-col gap-3">
            <div className="text-xs font-medium text-zinc-400 mb-1">
              文本内容
            </div>
            <Textarea
              className="nodrag w-full border rounded-xl px-4 py-3 text-sm leading-relaxed resize-none min-h-32 bg-zinc-800/80 hover:bg-zinc-800 border-zinc-700 focus:border-purple-500 text-white placeholder-zinc-500"
              placeholder="输入文本描述..."
              value={localPrompt}
              onChange={(e) => setLocalPrompt(e.target.value)}
              onBlur={handleBlur}
              onMouseDown={(e) => e.stopPropagation()}
              onWheel={(e) => e.stopPropagation()}
              rows={6}
            />
          </div>
        </div>
      )}
    </>
  );
};

TextNode.displayName = "TextNode";

export default memo(TextNode);
