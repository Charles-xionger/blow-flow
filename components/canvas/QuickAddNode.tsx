"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { useCanvasStore } from "@/store/useCanvasStore";
import { NodeType } from "@/types";

interface QuickAddNodeProps {
  nodeId: string;
  nodePosition: { x: number; y: number };
}

export function QuickAddNode({ nodePosition }: QuickAddNodeProps) {
  const [showMenu, setShowMenu] = useState(false);
  const addNode = useCanvasStore((state) => state.addNode);

  const handleAddNode = (type: NodeType) => {
    const newPosition = {
      x: nodePosition.x + 400,
      y: nodePosition.y,
    };
    addNode(type, newPosition);
    setShowMenu(false);
  };

  return (
    <div className="group/quick relative">
      {/* 触发按钮 */}
      <button
        className="flex h-6 w-6 items-center justify-center rounded-full border border-gray-600 bg-[#1a1a1a] text-gray-400 opacity-0 transition-all hover:border-blue-500 hover:bg-blue-500/10 hover:text-blue-500 group-hover/quick:opacity-100"
        onClick={() => setShowMenu(!showMenu)}
        title="快速添加节点"
      >
        <Plus size={14} />
      </button>

      {/* 节点类型选择菜单 */}
      {showMenu && (
        <>
          {/* 背景遮罩 */}
          <div
            className="fixed inset-0 z-[9998]"
            onClick={() => setShowMenu(false)}
          />

          {/* 菜单 */}
          <div className="absolute left-8 top-0 z-[9999] min-w-[160px] rounded-lg border border-gray-700 bg-[#1a1a1a] shadow-2xl">
            <div className="py-1">
              <div className="px-3 py-1 text-xs font-semibold text-gray-400">
                添加节点
              </div>

              <button
                onClick={() => handleAddNode(NodeType.TEXT_TO_IMAGE)}
                className="flex w-full items-center px-3 py-2 text-sm text-gray-200 hover:bg-gray-800"
              >
                文生图
              </button>

              <button
                onClick={() => handleAddNode(NodeType.TEXT_TO_VIDEO)}
                className="flex w-full items-center px-3 py-2 text-sm text-gray-200 hover:bg-gray-800"
              >
                文生视频
              </button>

              <button
                onClick={() => handleAddNode(NodeType.IMAGE_TO_IMAGE)}
                className="flex w-full items-center px-3 py-2 text-sm text-gray-200 hover:bg-gray-800"
              >
                图生图
              </button>

              <button
                onClick={() => handleAddNode(NodeType.IMAGE_TO_VIDEO)}
                className="flex w-full items-center px-3 py-2 text-sm text-gray-200 hover:bg-gray-800"
              >
                图生视频
              </button>

              <button
                onClick={() => handleAddNode(NodeType.START_END_TO_VIDEO)}
                className="flex w-full items-center px-3 py-2 text-sm text-gray-200 hover:bg-gray-800"
              >
                首尾帧生视频
              </button>

              <button
                onClick={() => handleAddNode(NodeType.CREATIVE_DESC)}
                className="flex w-full items-center px-3 py-2 text-sm text-gray-200 hover:bg-gray-800"
              >
                创意描述
              </button>

              <button
                onClick={() => handleAddNode(NodeType.ORIGINAL_IMAGE)}
                className="flex w-full items-center px-3 py-2 text-sm text-gray-200 hover:bg-gray-800"
              >
                原始图片
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
