"use client";

import { NodeProps, Node, NodeResizer } from "@xyflow/react";
import { NodeData } from "@/types";
import { canvasDraftStorage, useCanvasStore } from "@/store/useCanvasStore";
import { Group, Edit3 } from "lucide-react";
import { useState } from "react";

export function GroupNode({ id, data, selected }: NodeProps<Node<NodeData>>) {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [title, setTitle] = useState(data.customTitle || data.label);

  const startEditing = () => { setTitle(data.customTitle || data.label); setIsEditingTitle(true); };

  const handleTitleSubmit = () => {
    if (title.trim()) {
      updateNodeData(id, { customTitle: title.trim() });
    }
    setIsEditingTitle(false);
  };

  return (
    <div
      className={`rounded-lg border-2 border-dashed bg-gray-900/20 backdrop-blur-sm transition-colors ${
        selected ? "border-blue-500" : "border-gray-600"
      }`}
      style={{
        width: "100%",
        height: "100%",
      }}
    >
      <NodeResizer isVisible={selected} minWidth={160} minHeight={100}
        onResizeStart={() => canvasDraftStorage.beginInteraction('resize')}
        onResizeEnd={() => canvasDraftStorage.endInteraction('resize')} />
      {/* 分组标题 */}
      <div className="absolute -top-8 left-2 flex items-center gap-2">
        <Group size={16} className="text-gray-400" />
        {isEditingTitle ? (
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={handleTitleSubmit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                handleTitleSubmit();
              } else if (e.key === "Escape") {
                setTitle(data.customTitle || data.label);
                setIsEditingTitle(false);
              }
            }}
            className="nodrag nopan nowheel rounded border border-gray-600 bg-[#1a1a1a] px-2 py-1 text-sm text-white outline-none focus:border-blue-500"
            autoFocus
            onFocus={(e) => e.target.select()}
          />
        ) : (
          <div
            className="flex items-center gap-2 rounded px-2 py-1 text-sm font-medium text-gray-300 hover:bg-gray-800/50"
            onDoubleClick={startEditing}
          >
            <span>{data.customTitle || data.label}</span>
            <Edit3
              size={12}
              className="cursor-pointer text-gray-500 opacity-0 transition-opacity group-hover:opacity-100"
              onClick={startEditing}
            />
          </div>
        )}
      </div>

      {/* 分组内容区域 - 子节点会自动渲染在这里 */}
      <div className="flex h-full w-full items-center justify-center p-4 text-gray-500">
        {/* 占位符，仅在空分组时显示 */}
      </div>
    </div>
  );
}
