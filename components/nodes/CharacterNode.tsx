"use client";

import { memo, useState } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { Handle, Position } from "@xyflow/react";
import { useCanvasStore } from "@/store/useCanvasStore";
import { User, Edit, Sparkles } from "lucide-react";
import type { NodeData } from "@/types";
import { EditableTitle } from "./shared/EditableTitle";
import { QuickAddNode } from "../canvas/QuickAddNode";

const CharacterNode = ({ id, data }: NodeProps<Node<NodeData>>) => {
  const nodes = useCanvasStore((state) => state.nodes);
  const currentNode = nodes.find((n) => n.id === id);
  const nodePosition = currentNode?.position || { x: 0, y: 0 };

  const [showEditModal, setShowEditModal] = useState(false);

  const character = data.characterData;

  return (
    <>
      <EditableTitle
        nodeId={id}
        defaultTitle={data.label}
        customTitle={data.customTitle}
      />

      {/* 输入Handle（可选，用于连接其他节点） */}
      <Handle
        type="target"
        position={Position.Left}
        style={{
          width: "12px",
          height: "12px",
          background: "#8b5cf6",
          border: "2px solid #1e1e1e",
        }}
      />

      {/* 节点主体 */}
      <div
        className="group relative bg-zinc-900 rounded-xl border-2 border-purple-500/30 overflow-hidden transition-all"
        style={{ width: "320px", height: "240px" }}
      >
        {character ? (
          <div className="h-full flex flex-col">
            {/* 角色头像区域 */}
            <div className="relative h-40 bg-gradient-to-b from-purple-900/20 to-zinc-900">
              {character.referenceImages[0] ? (
                <img
                  src={character.referenceImages[0]}
                  alt={character.name}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <User className="w-16 h-16 text-purple-500/30" />
                </div>
              )}
              {/* 参考图数量标识 */}
              {character.referenceImages.length > 1 && (
                <div className="absolute bottom-2 right-2 bg-black/60 backdrop-blur-sm px-2 py-1 rounded text-xs text-white">
                  +{character.referenceImages.length - 1}
                </div>
              )}
            </div>

            {/* 角色信息 */}
            <div className="flex-1 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-white truncate">
                  {character.name}
                </h3>
                <button
                  onClick={() => setShowEditModal(true)}
                  className="p-1 hover:bg-white/5 rounded transition-colors"
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <Edit className="w-4 h-4 text-gray-400" />
                </button>
              </div>

              <p className="text-xs text-gray-400 line-clamp-2">
                {character.description}
              </p>

              {/* 标签 */}
              {character.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {character.tags.slice(0, 3).map((tag, index) => (
                    <span
                      key={index}
                      className="px-2 py-0.5 bg-purple-500/20 text-purple-300 text-xs rounded"
                    >
                      {tag}
                    </span>
                  ))}
                  {character.tags.length > 3 && (
                    <span className="px-2 py-0.5 bg-zinc-800 text-gray-400 text-xs rounded">
                      +{character.tags.length - 3}
                    </span>
                  )}
                </div>
              )}

              {/* LoRA状态 */}
              {character.loraStatus && character.loraStatus !== "none" && (
                <div className="flex items-center gap-1 text-xs">
                  <Sparkles className="w-3 h-3" />
                  <span
                    className={
                      character.loraStatus === "ready"
                        ? "text-green-400"
                        : character.loraStatus === "training"
                          ? "text-yellow-400"
                          : character.loraStatus === "failed"
                            ? "text-red-400"
                            : "text-gray-400"
                    }
                  >
                    LoRA:{" "}
                    {character.loraStatus === "ready"
                      ? "Ready"
                      : character.loraStatus === "training"
                        ? "Training..."
                        : character.loraStatus === "failed"
                          ? "Failed"
                          : "Pending"}
                  </span>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="h-full flex flex-col items-center justify-center p-6 text-center">
            <User className="w-16 h-16 text-purple-500/30 mb-4" />
            <p className="text-sm text-gray-400 mb-4">
              未选择角色
              <br />
              点击下方选择或创建角色
            </p>
            <button
              onClick={() => setShowEditModal(true)}
              onMouseDown={(e) => e.stopPropagation()}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white text-sm rounded-lg transition-colors"
            >
              选择角色
            </button>
          </div>
        )}
      </div>

      {/* 输出Handle */}
      <Handle
        type="source"
        position={Position.Right}
        id="output"
        style={{
          width: "12px",
          height: "12px",
          background: "#8b5cf6",
          border: "2px solid #1e1e1e",
        }}
      >
        <QuickAddNode nodeId={id} nodePosition={nodePosition} />
      </Handle>

      {/* 角色选择/编辑模态框 - 暂时简化，后续会创建完整的CharacterModal */}
      {showEditModal && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setShowEditModal(false)}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div
            className="bg-zinc-900 rounded-xl p-6 max-w-md w-full mx-4 border border-zinc-800"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-white mb-4">选择角色</h3>
            <p className="text-sm text-gray-400 mb-4">
              角色库功能正在开发中...
              <br />
              将在后续步骤中完成集成
            </p>
            <button
              onClick={() => setShowEditModal(false)}
              className="w-full px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white rounded-lg transition-colors"
            >
              关闭
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export default memo(CharacterNode);
