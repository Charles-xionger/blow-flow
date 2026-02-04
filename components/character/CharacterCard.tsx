"use client";

import { User, Edit, Trash2, Sparkles } from "lucide-react";
import type { Character } from "@/types";
import { useCanvasStore } from "@/store/useCanvasStore";
import { NodeType } from "@/types";

interface CharacterCardProps {
  character: Character;
  onEdit: () => void;
  onDelete: () => void;
}

export function CharacterCard({
  character,
  onEdit,
  onDelete,
}: CharacterCardProps) {
  const addNode = useCanvasStore((state) => state.addNode);

  // 拖拽到画布创建节点
  const handleAddToCanvas = () => {
    const nodeId = addNode(NodeType.CHARACTER, { x: 100, y: 100 });
    const updateNodeData = useCanvasStore.getState().updateNodeData;

    // 设置角色数据
    updateNodeData(nodeId, {
      characterId: character.id,
      characterData: character,
    });
  };

  return (
    <div className="group relative bg-zinc-800 rounded-lg border border-zinc-700 hover:border-purple-500/50 transition-all overflow-hidden">
      <div className="flex gap-3 p-3">
        {/* 头像 */}
        <div className="relative w-16 h-16 flex-shrink-0 bg-zinc-900 rounded-lg overflow-hidden">
          {character.referenceImages[0] ? (
            <img
              src={character.referenceImages[0]}
              alt={character.name}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <User className="w-8 h-8 text-purple-500/30" />
            </div>
          )}
          {/* 参考图数量 */}
          {character.referenceImages.length > 1 && (
            <div className="absolute bottom-1 right-1 bg-black/60 backdrop-blur-sm px-1.5 py-0.5 rounded text-xs text-white">
              {character.referenceImages.length}
            </div>
          )}
        </div>

        {/* 信息 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between mb-1">
            <h3 className="font-medium text-white truncate pr-2">
              {character.name}
            </h3>
            {character.loraStatus && character.loraStatus !== "none" && (
              <div title={`LoRA: ${character.loraStatus}`}>
                <Sparkles
                  className={`w-4 h-4 shrink-0 ${
                    character.loraStatus === "ready"
                      ? "text-green-400"
                      : character.loraStatus === "training"
                        ? "text-yellow-400"
                        : "text-gray-400"
                  }`}
                />
              </div>
            )}
          </div>

          <p className="text-xs text-gray-400 line-clamp-2 mb-2">
            {character.description}
          </p>

          {/* 标签 */}
          {character.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {character.tags.slice(0, 3).map((tag, index) => (
                <span
                  key={index}
                  className="px-1.5 py-0.5 bg-purple-500/20 text-purple-300 text-xs rounded"
                >
                  {tag}
                </span>
              ))}
              {character.tags.length > 3 && (
                <span className="px-1.5 py-0.5 bg-zinc-700 text-gray-400 text-xs rounded">
                  +{character.tags.length - 3}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 悬浮操作按钮 */}
      <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
        <button
          onClick={onEdit}
          className="p-1.5 bg-zinc-900/90 backdrop-blur-sm hover:bg-zinc-800 rounded transition-colors"
          title="编辑"
        >
          <Edit className="w-3.5 h-3.5 text-gray-300" />
        </button>
        <button
          onClick={onDelete}
          className="p-1.5 bg-zinc-900/90 backdrop-blur-sm hover:bg-red-900/50 rounded transition-colors"
          title="删除"
        >
          <Trash2 className="w-3.5 h-3.5 text-red-400" />
        </button>
      </div>

      {/* 添加到画布按钮 */}
      <button
        onClick={handleAddToCanvas}
        className="w-full py-2 bg-zinc-900/50 hover:bg-purple-900/30 text-xs text-gray-400 hover:text-purple-300 transition-colors border-t border-zinc-700"
      >
        添加到画布
      </button>
    </div>
  );
}
