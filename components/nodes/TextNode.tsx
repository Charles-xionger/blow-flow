"use client";

import { memo, useCallback, useState, useEffect } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { BaseNode, NodeSurface } from "./BaseNode";
import { promptText } from "@/lib/canvas/prompt";
import { useCanvasStore } from "@/store/useCanvasStore";
import { FileText } from "lucide-react";
import type { NodeData } from "@/types";
import { Textarea } from "@/components/ui/textarea";

const TextNode = (props: NodeProps<Node<NodeData>>) => {
  const { id, data, selected } = props;
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const singleSelected = useCanvasStore((state) => state.selectedNodeIds.length === 1);

  const shouldShowPanel = selected && singleSelected;
  const [localPrompt, setLocalPrompt] = useState(promptText(data.prompt));

  // 使用 key 或者不在 effect 中设置状态，而是在渲染时检查
  useEffect(() => {
    // 使用 setTimeout 将 setState 推迟到下一个事件循环，避免同步调用
    const timer = setTimeout(() => {
      if (data.prompt !== localPrompt) {
        setLocalPrompt(promptText(data.prompt));
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
    <BaseNode {...props}>

      <NodeSurface>
        <div className="relative w-full h-full p-4">
          <div className="w-full h-full flex flex-col items-center justify-center text-zinc-400">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4 bg-zinc-800/50 text-purple-500">
              <FileText size={28} className="opacity-60" />
            </div>
            <div className="text-sm font-medium opacity-60 mb-2">文本描述</div>
            <div className="text-xs text-zinc-500 text-center px-4 max-h-32 overflow-y-auto">
              {promptText(data.prompt) || "暂无内容"}
            </div>
          </div>
        </div>
      </NodeSurface>

      {shouldShowPanel && (
        <div
          className="node-panel nodrag nopan nowheel absolute top-full left-1/2 -translate-x-1/2 min-w-100 pt-4 z-70 pointer-events-auto"
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
              onChange={(e) => {
                setLocalPrompt(e.target.value);
                updateNodeData(id, { prompt: e.target.value });
              }}
              onBlur={handleBlur}
              onMouseDown={(e) => e.stopPropagation()}
              onWheel={(e) => e.stopPropagation()}
              rows={6}
            />
          </div>
        </div>
      )}
    </BaseNode>
  );
};

TextNode.displayName = "TextNode";

export default memo(TextNode);
