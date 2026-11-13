"use client";

import { nodeContentEqual } from "@/lib/canvas/node-content";

import { CanvasPreview } from "@/components/ui/canvas-preview";

import { memo, useState } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { Edit, Library, Sparkles, User } from "lucide-react";
import type { NodeData } from "@/types";
import { CharacterModal } from "../character/CharacterModal";
import { NodeShell, NodeToolbarButton } from "./NodeShell";

type LoraStatus = NonNullable<NonNullable<NodeData["characterData"]>["loraStatus"]>;
const loraStatus: Record<Exclude<LoraStatus, "none">, { label: string; className: string }> = {
  pending: { label: "Pending", className: "text-gray-400" },
  training: { label: "Training...", className: "text-yellow-400" },
  ready: { label: "Ready", className: "text-green-400" },
  failed: { label: "Failed", className: "text-red-400" },
};

const CharacterNode = (props: NodeProps<Node<NodeData>>) => {
  const { data } = props;
  const [showCharacterModal, setShowCharacterModal] = useState(false);
  const character = data.characterData;
  const lora = character?.loraStatus && character.loraStatus !== "none" ? loraStatus[character.loraStatus] : undefined;

  return (
    <NodeShell {...props} stageTestId="character-stage"
      toolbar={<>
        <NodeToolbarButton label="编辑角色" icon={Edit} disabled={!character} onClick={() => setShowCharacterModal(true)} />
        <NodeToolbarButton label="打开角色库" icon={Library}
          onClick={() => window.dispatchEvent(new CustomEvent("openSidebarPanel", { detail: { panel: "CHARACTER" } }))} />
      </>}
    >
      {character ? (
        <div className="h-full flex flex-col">
          {/* 角色头像区域 */}
          <div className="relative h-40 bg-gradient-to-b from-purple-900/20 to-zinc-900">
            {character.referenceImages[0] ? (
              <CanvasPreview src={character.referenceImages[0]} alt={character.name} draggable={false} className="w-full h-full object-cover" />
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

          <div className="flex-1 p-3 space-y-2">
            <h3 className="font-semibold text-white truncate">{character.name}</h3>
            <p className="text-xs text-gray-400 line-clamp-2">{character.description}</p>

            {character.tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {character.tags.slice(0, 3).map((tag, index) => (
                  <span key={index} className="px-2 py-0.5 bg-purple-500/20 text-purple-300 text-xs rounded">{tag}</span>
                ))}
                {character.tags.length > 3 && (
                  <span className="px-2 py-0.5 bg-zinc-800 text-gray-400 text-xs rounded">+{character.tags.length - 3}</span>
                )}
              </div>
            )}

            {lora && (
              <div className="flex items-center gap-1 text-xs">
                <Sparkles className="w-3 h-3" />
                <span className={lora.className}>LoRA: {lora.label}</span>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="h-full flex flex-col items-center justify-center p-6 text-center">
          <User className="w-16 h-16 text-purple-500/30 mb-4" />
          <p className="text-sm text-gray-400">
            未选择角色
            <br />
            请在角色库中选择
          </p>
        </div>
      )}
      {/* Outside the toolbar, which unmounts when the node loses selection. */}
      {showCharacterModal && character && (
        <CharacterModal
          character={character}
          onClose={(saved) => {
            setShowCharacterModal(false);
            // 触发角色列表刷新
            if (saved) window.dispatchEvent(new CustomEvent("characterSaved"));
          }}
        />
      )}
    </NodeShell>
  );
};

export default memo(CharacterNode, nodeContentEqual);
