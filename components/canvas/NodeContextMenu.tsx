"use client";

import { useCanvasStore } from "@/store/useCanvasStore";
import { Copy, Trash2, Group, Ungroup, Play, ChevronRight } from "lucide-react";
import { NodeType } from "@/types";

interface NodeContextMenuProps {
  nodeId: string;
  x: number;
  y: number;
  onClose: () => void;
}

export function NodeContextMenu({
  nodeId,
  x,
  y,
  onClose,
}: NodeContextMenuProps) {
  const {
    nodes,
    selectedNodeIds,
    duplicateNode,
    deleteNode,
    deleteSelectedNodes,
    groupNodes,
    ungroupNodes,
    addNode,
  } = useCanvasStore();

  const node = nodes.find((n) => n.id === nodeId);
  const isGroup = node?.type === NodeType.GROUP;
  const isMultipleSelected = selectedNodeIds.length > 1;

  const handleDuplicate = () => {
    duplicateNode(nodeId);
    onClose();
  };

  const handleDelete = () => {
    if (isMultipleSelected && selectedNodeIds.includes(nodeId)) {
      deleteSelectedNodes();
    } else {
      deleteNode(nodeId);
    }
    onClose();
  };

  const handleGroup = () => {
    if (isMultipleSelected) {
      groupNodes(selectedNodeIds);
    } else {
      groupNodes([nodeId]);
    }
    onClose();
  };

  const handleUngroup = () => {
    ungroupNodes(nodeId);
    onClose();
  };

  const handleAddConnectedNode = (type: NodeType) => {
    if (!node) return;
    const newPosition = {
      x: node.position.x + 400,
      y: node.position.y,
    };
    addNode(type, newPosition);
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
          {/* 复制 */}
          <button
            onClick={handleDuplicate}
            className="flex w-full items-center gap-3 px-4 py-2 text-sm text-gray-200 hover:bg-gray-800"
          >
            <Copy size={16} />
            <span>复制节点</span>
            <span className="ml-auto text-xs text-gray-500">Cmd+D</span>
          </button>

          {/* 删除 */}
          <button
            onClick={handleDelete}
            className="flex w-full items-center gap-3 px-4 py-2 text-sm text-gray-200 hover:bg-gray-800"
          >
            <Trash2 size={16} />
            <span>
              {isMultipleSelected && selectedNodeIds.includes(nodeId)
                ? `删除选中的节点 (${selectedNodeIds.length})`
                : "删除节点"}
            </span>
            <span className="ml-auto text-xs text-gray-500">Del</span>
          </button>

          <div className="my-1 border-t border-gray-700" />

          {/* 分组/取消分组 */}
          {isGroup ? (
            <button
              onClick={handleUngroup}
              className="flex w-full items-center gap-3 px-4 py-2 text-sm text-gray-200 hover:bg-gray-800"
            >
              <Ungroup size={16} />
              <span>取消分组</span>
            </button>
          ) : (
            <button
              onClick={handleGroup}
              className="flex w-full items-center gap-3 px-4 py-2 text-sm text-gray-200 hover:bg-gray-800"
              disabled={!isMultipleSelected && selectedNodeIds.length === 0}
            >
              <Group size={16} />
              <span>
                {isMultipleSelected
                  ? `创建分组 (${selectedNodeIds.length})`
                  : "创建分组"}
              </span>
              <span className="ml-auto text-xs text-gray-500">Cmd+G</span>
            </button>
          )}

          {!isGroup && (
            <>
              <div className="my-1 border-t border-gray-700" />

              {/* 快速添加连接节点 */}
              <div className="group relative">
                <button className="flex w-full items-center gap-3 px-4 py-2 text-sm text-gray-200 hover:bg-gray-800">
                  <Play size={16} />
                  <span>添加连接节点</span>
                  <ChevronRight size={16} className="ml-auto" />
                </button>

                {/* 子菜单 */}
                <div className="absolute left-full top-0 ml-1 hidden min-w-[180px] rounded-lg border border-gray-700 bg-[#1a1a1a] shadow-2xl group-hover:block">
                  <div className="py-1">
                    <button
                      onClick={() =>
                        handleAddConnectedNode(NodeType.TEXT_TO_IMAGE)
                      }
                      className="flex w-full items-center gap-3 px-4 py-2 text-sm text-gray-200 hover:bg-gray-800"
                    >
                      文生图
                    </button>
                    <button
                      onClick={() =>
                        handleAddConnectedNode(NodeType.TEXT_TO_VIDEO)
                      }
                      className="flex w-full items-center gap-3 px-4 py-2 text-sm text-gray-200 hover:bg-gray-800"
                    >
                      文生视频
                    </button>
                    <button
                      onClick={() =>
                        handleAddConnectedNode(NodeType.IMAGE_TO_IMAGE)
                      }
                      className="flex w-full items-center gap-3 px-4 py-2 text-sm text-gray-200 hover:bg-gray-800"
                    >
                      图生图
                    </button>
                    <button
                      onClick={() =>
                        handleAddConnectedNode(NodeType.IMAGE_TO_VIDEO)
                      }
                      className="flex w-full items-center gap-3 px-4 py-2 text-sm text-gray-200 hover:bg-gray-800"
                    >
                      图生视频
                    </button>
                    <button
                      onClick={() =>
                        handleAddConnectedNode(NodeType.CREATIVE_DESC)
                      }
                      className="flex w-full items-center gap-3 px-4 py-2 text-sm text-gray-200 hover:bg-gray-800"
                    >
                      创意描述
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
