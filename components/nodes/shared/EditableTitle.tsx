"use client";

import { useState } from "react";
import { Edit3 } from "lucide-react";
import { useCanvasStore } from "@/store/useCanvasStore";

interface EditableTitleProps {
  nodeId: string;
  defaultTitle: string;
  customTitle?: string;
}

export function EditableTitle({
  nodeId,
  defaultTitle,
  customTitle,
}: EditableTitleProps) {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState(customTitle || defaultTitle);

  const handleSubmit = () => {
    const trimmedTitle = title.trim();
    if (trimmedTitle && trimmedTitle !== defaultTitle) {
      updateNodeData(nodeId, { customTitle: trimmedTitle });
    } else if (!trimmedTitle || trimmedTitle === defaultTitle) {
      // 如果输入为空或等于默认值，清除自定义标题
      updateNodeData(nodeId, { customTitle: undefined });
      setTitle(defaultTitle);
    }
    setIsEditing(false);
  };

  const handleCancel = () => {
    setTitle(customTitle || defaultTitle);
    setIsEditing(false);
  };

  return (
    <div className="absolute -top-7 left-0 z-10 flex items-center gap-1">
      {isEditing ? (
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={handleSubmit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              handleSubmit();
            } else if (e.key === "Escape") {
              handleCancel();
            }
          }}
          className="rounded border border-blue-500 bg-[#1a1a1a] px-2 py-0.5 text-xs font-medium text-white outline-none"
          style={{ minWidth: "100px", maxWidth: "200px" }}
          autoFocus
          onFocus={(e) => e.target.select()}
        />
      ) : (
        <div
          className="group/title flex items-center gap-1 rounded px-2 py-0.5 hover:bg-gray-800/50"
          onDoubleClick={() => setIsEditing(true)}
        >
          <span className="text-xs font-medium text-gray-300">
            {customTitle || defaultTitle}
          </span>
          <Edit3
            size={10}
            className="cursor-pointer text-gray-500 opacity-0 transition-opacity group-hover/title:opacity-100"
            onClick={() => setIsEditing(true)}
          />
        </div>
      )}
    </div>
  );
}
