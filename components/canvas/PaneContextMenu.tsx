"use client";

import { useCanvasStore } from "@/store/useCanvasStore";
import { Plus, Image, Video, FileImage, Wand2, FilmIcon } from "lucide-react";
import { NodeType } from "@/types";
import { useReactFlow } from "@xyflow/react";

interface PaneContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
}

export function PaneContextMenu({ x, y, onClose }: PaneContextMenuProps) {
  const { addNode } = useCanvasStore();
  const reactFlow = useReactFlow();

  const handleAddNode = (type: NodeType) => {
    // 将屏幕坐标转换为画布坐标
    const position = reactFlow.screenToFlowPosition({ x, y });
    addNode(type, position);
    onClose();
  };

  // 计算菜单位置，防止超出视口
  const menuStyle: React.CSSProperties = {
    position: "fixed",
    left: `${x}px`,
    top: `${y}px`,
    zIndex: 9999,
  };

  return (
    <>
      {/* 背景遮罩 */}
      <div
        className="fixed inset-0 z-[9998]"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />

      {/* 菜单内容 */}
      <div
        style={menuStyle}
        className="min-w-[200px] rounded-lg border border-gray-700 bg-[#1a1a1a] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="py-1">
          <div className="px-4 py-2 text-xs font-semibold text-gray-400">
            添加节点
          </div>

          {/* 文生图 */}
          <button
            onClick={() => handleAddNode(NodeType.TEXT_TO_IMAGE)}
            className="flex w-full items-center gap-3 px-4 py-2 text-sm text-gray-200 hover:bg-gray-800"
          >
            <Image size={16} />
            <span>文生图</span>
          </button>

          {/* 文生视频 */}
          <button
            onClick={() => handleAddNode(NodeType.TEXT_TO_VIDEO)}
            className="flex w-full items-center gap-3 px-4 py-2 text-sm text-gray-200 hover:bg-gray-800"
          >
            <Video size={16} />
            <span>文生视频</span>
          </button>

          <div className="my-1 border-t border-gray-700" />

          {/* 图生图 */}
          <button
            onClick={() => handleAddNode(NodeType.IMAGE_TO_IMAGE)}
            className="flex w-full items-center gap-3 px-4 py-2 text-sm text-gray-200 hover:bg-gray-800"
          >
            <FileImage size={16} />
            <span>图生图</span>
          </button>

          {/* 图生视频 */}
          <button
            onClick={() => handleAddNode(NodeType.IMAGE_TO_VIDEO)}
            className="flex w-full items-center gap-3 px-4 py-2 text-sm text-gray-200 hover:bg-gray-800"
          >
            <FilmIcon size={16} />
            <span>图生视频</span>
          </button>

          {/* 首尾帧生视频 */}
          <button
            onClick={() => handleAddNode(NodeType.START_END_TO_VIDEO)}
            className="flex w-full items-center gap-3 px-4 py-2 text-sm text-gray-200 hover:bg-gray-800"
          >
            <FilmIcon size={16} />
            <span>首尾帧生视频</span>
          </button>

          <div className="my-1 border-t border-gray-700" />

          {/* 创意描述 */}
          <button
            onClick={() => handleAddNode(NodeType.CREATIVE_DESC)}
            className="flex w-full items-center gap-3 px-4 py-2 text-sm text-gray-200 hover:bg-gray-800"
          >
            <Wand2 size={16} />
            <span>创意描述</span>
          </button>

          {/* 原始图片 */}
          <button
            onClick={() => handleAddNode(NodeType.ORIGINAL_IMAGE)}
            className="flex w-full items-center gap-3 px-4 py-2 text-sm text-gray-200 hover:bg-gray-800"
          >
            <Plus size={16} />
            <span>原始图片</span>
          </button>
        </div>
      </div>
    </>
  );
}
