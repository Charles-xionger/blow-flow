"use client";

import { memo, useCallback, useRef, useEffect } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { Handle, Position } from "@xyflow/react";
import { useCanvasStore } from "@/store/useCanvasStore";
import { Image as ImageIcon, Upload, X } from "lucide-react";
import type { NodeData } from "@/types";
import { EditableTitle } from "./shared/EditableTitle";
import { QuickAddNode } from "../canvas/QuickAddNode";
import { ImageWithActions } from "@/components/ui/image-with-actions";

const OriginalImageNode = ({
  id,
  data,
  selected,
}: NodeProps<Node<NodeData>>) => {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const nodes = useCanvasStore((state) => state.nodes);
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds);
  const currentNode = nodes.find((n) => n.id === id);
  const nodePosition = currentNode?.position || { x: 0, y: 0 };
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 只有在单选状态下才显示控制面板
  const shouldShowPanel = selected && selectedNodeIds.length === 1;

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      // 显示加载状态
      updateNodeData(id, { isLoading: true });

      try {
        // 上传到服务器
        const formData = new FormData();
        formData.append("file", file);

        const response = await fetch("/api/upload/image", {
          method: "POST",
          body: formData,
        });

        const result = await response.json();

        if (result.success) {
          // 使用永久 URL
          updateNodeData(id, {
            imageSrc: result.data.url,
            isLoading: false,
          });
        } else {
          throw new Error(result.error);
        }
      } catch (error) {
        console.error("Upload failed:", error);
        updateNodeData(id, {
          error: error instanceof Error ? error.message : "上传失败",
          isLoading: false,
        });
      }
    },
    [id, updateNodeData],
  );

  const handlePaste = useCallback(
    async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();

            // 显示加载状态
            updateNodeData(id, { isLoading: true });

            try {
              // 上传到服务器
              const formData = new FormData();
              formData.append("file", file);

              const response = await fetch("/api/upload/image", {
                method: "POST",
                body: formData,
              });

              const result = await response.json();

              if (result.success) {
                // 使用永久 URL
                updateNodeData(id, {
                  imageSrc: result.data.url,
                  isLoading: false,
                });
              } else {
                throw new Error(result.error);
              }
            } catch (error) {
              console.error("Upload failed:", error);
              updateNodeData(id, {
                error: error instanceof Error ? error.message : "上传失败",
                isLoading: false,
              });
            }
            break;
          }
        }
      }
    },
    [id, updateNodeData],
  );

  useEffect(() => {
    if (selected) {
      document.addEventListener("paste", handlePaste);
      return () => document.removeEventListener("paste", handlePaste);
    }
  }, [selected, handlePaste]);

  const hasResult = !!data.imageSrc && !data.isLoading;
  const isLoading = data.isLoading;
  const hasError = !!data.error;

  return (
    <>
      {/* 可编辑标题 */}
      <EditableTitle
        nodeId={id}
        defaultTitle={data.label}
        customTitle={data.customTitle}
      />

      {/* 输出句柄 */}
      <div className="absolute right-0 top-1/2 -translate-y-1/2 flex items-center">
        <QuickAddNode nodeId={id} nodePosition={nodePosition} />
        <Handle type="source" position={Position.Right} id="output" />
      </div>

      {/* 节点显示区域 */}
      <div
        style={{ width: "320px", height: "240px" }}
        className={`relative rounded-2xl border ${
          selected
            ? "border-amber-500 ring-2 ring-amber-500/30"
            : "border-zinc-700/50"
        } bg-[#1a1a1a] overflow-hidden shadow-xl group transition-all duration-200`}
      >
        {isLoading ? (
          <div className="w-full h-full flex flex-col items-center justify-center text-zinc-500">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4 bg-zinc-800/50">
              <div className="w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
            </div>
            <span className="text-sm font-medium opacity-60">上传中...</span>
          </div>
        ) : hasError ? (
          <div className="w-full h-full flex flex-col items-center justify-center text-red-500">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4 bg-red-500/10">
              <X size={28} className="opacity-60" />
            </div>
            <span className="text-sm font-medium opacity-60">上传失败</span>
            <span className="text-xs opacity-40 mt-1">{data.error}</span>
          </div>
        ) : hasResult ? (
          <div className="relative w-full h-full cursor-pointer">
            <ImageWithActions
              src={data.imageSrc || ""}
              alt="Uploaded image"
              className="w-full h-full object-contain"
            />
          </div>
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-zinc-500">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4 bg-zinc-800/50 text-zinc-500">
              <ImageIcon size={28} className="opacity-60" />
            </div>
            <span className="text-sm font-medium opacity-60">原图</span>
            <span className="text-xs opacity-40 mt-1">选中节点上传图片</span>
          </div>
        )}
      </div>

      {/* 控制面板 */}
      {shouldShowPanel && (
        <div
          className="absolute top-full left-1/2 -translate-x-1/2 min-w-100 pt-4 z-70 pointer-events-auto"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="bg-[#1a1a1a]/95 backdrop-blur-xl border border-zinc-700/50 rounded-2xl p-4 flex flex-col gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              className="hidden"
            />

            {!data.imageSrc ? (
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full py-8 border-2 border-dashed border-zinc-700 rounded-xl hover:border-amber-500 hover:bg-amber-500/10 transition-all flex flex-col items-center justify-center gap-2"
              >
                <Upload className="w-8 h-8 text-zinc-400" />
                <span className="text-sm text-zinc-300">
                  点击上传或粘贴图片
                </span>
                <span className="text-xs text-zinc-500">
                  支持 JPG、PNG、GIF 格式
                </span>
              </button>
            ) : (
              <div className="flex items-center gap-3">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex-1 h-10 px-4 rounded-lg text-sm font-semibold border border-zinc-700 text-white hover:bg-zinc-800 transition-all"
                >
                  重新上传
                </button>
                <button
                  onClick={() => updateNodeData(id, { imageSrc: undefined })}
                  className="shrink-0 h-10 px-4 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/30 transition-all"
                >
                  <X size={16} />
                  删除图片
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
};

OriginalImageNode.displayName = "OriginalImageNode";

export default memo(OriginalImageNode);
