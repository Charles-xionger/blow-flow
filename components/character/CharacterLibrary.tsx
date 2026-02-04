"use client";

import { useState, useEffect, useCallback } from "react";
import { User, Plus, Search } from "lucide-react";
import type { Character } from "@/types";
import { CharacterCard } from "./CharacterCard";
import { CharacterModal } from "./CharacterModal";

export function CharacterLibrary() {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [editingCharacter, setEditingCharacter] = useState<Character | null>(
    null,
  );

  // 加载角色列表
  const loadCharacters = useCallback(async () => {
    try {
      setIsLoading(true);
      const url = searchQuery
        ? `/api/character?q=${encodeURIComponent(searchQuery)}`
        : "/api/character";

      const response = await fetch(url);
      const result = await response.json();

      if (result.success) {
        setCharacters(result.data);
      }
    } catch (error) {
      console.error("Failed to load characters:", error);
    } finally {
      setIsLoading(false);
    }
  }, [searchQuery]);

  useEffect(() => {
    loadCharacters();
  }, [loadCharacters]);

  const handleCreateNew = () => {
    setEditingCharacter(null);
    setShowModal(true);
  };

  const handleEdit = (character: Character) => {
    setEditingCharacter(character);
    setShowModal(true);
  };

  const handleDelete = async (characterId: string) => {
    if (!confirm("确定要删除这个角色吗？")) return;

    try {
      const response = await fetch(`/api/character/${characterId}`, {
        method: "DELETE",
      });

      const result = await response.json();

      if (result.success) {
        await loadCharacters();
      } else {
        alert(`删除失败: ${result.error}`);
      }
    } catch (error) {
      console.error("Failed to delete character:", error);
      alert("删除失败");
    }
  };

  const handleModalClose = (saved: boolean) => {
    setShowModal(false);
    setEditingCharacter(null);
    if (saved) {
      loadCharacters();
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* 头部 */}
      <div className="p-4 border-b border-zinc-800">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <User className="w-5 h-5 text-purple-500" />
            <h2 className="text-lg font-semibold text-white">角色库</h2>
          </div>
          <button
            onClick={handleCreateNew}
            className="p-2 bg-purple-600 hover:bg-purple-700 rounded-lg transition-colors"
            title="创建新角色"
          >
            <Plus className="w-5 h-5 text-white" />
          </button>
        </div>

        {/* 搜索框 */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="text"
            placeholder="搜索角色名称、描述或标签..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500/50"
          />
        </div>
      </div>

      {/* 角色网格 */}
      <div className="flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <div className="flex items-center justify-center h-32">
            <div className="text-gray-500">加载中...</div>
          </div>
        ) : characters.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center p-8">
            <User className="w-16 h-16 text-gray-600 mb-4" />
            <p className="text-gray-400 mb-2">
              {searchQuery ? "未找到匹配的角色" : "还没有创建任何角色"}
            </p>
            <p className="text-sm text-gray-500 mb-4">
              {searchQuery
                ? "尝试使用其他关键词搜索"
                : "点击右上角的 + 按钮创建第一个角色"}
            </p>
            {!searchQuery && (
              <button
                onClick={handleCreateNew}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white text-sm rounded-lg transition-colors"
              >
                创建角色
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3">
            {characters.map((character) => (
              <CharacterCard
                key={character.id}
                character={character}
                onEdit={() => handleEdit(character)}
                onDelete={() => handleDelete(character.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 角色编辑模态框 */}
      {showModal && (
        <CharacterModal
          character={editingCharacter}
          onClose={handleModalClose}
        />
      )}
    </div>
  );
}
