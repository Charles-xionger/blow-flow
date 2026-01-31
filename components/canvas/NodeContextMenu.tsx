"use client";

import { useCanvasStore } from "@/store/useCanvasStore";
import {
  Copy,
  Trash2,
  Group,
  Ungroup,
  Play,
  ChevronRight,
  Download,
} from "lucide-react";
import { NodeType } from "@/types";
import { useState } from "react";

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
    addConnectedNode,
  } = useCanvasStore();

  const [isDownloading, setIsDownloading] = useState(false);

  const node = nodes.find((n) => n.id === nodeId);
  const isGroup = node?.type === NodeType.GROUP;
  const isMultipleSelected = selectedNodeIds.length > 1;

  // 获取所有选中节点中有媒体内容的节点
  const selectedNodesWithMedia = nodes.filter(
    (n) =>
      selectedNodeIds.includes(n.id) && (n.data.imageSrc || n.data.videoSrc),
  );
  const hasMediaToDownload = selectedNodesWithMedia.length > 0;

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

  const handleDownloadSelected = async () => {
    if (selectedNodesWithMedia.length === 0) return;

    setIsDownloading(true);

    try {
      // 准备下载列表
      const items = selectedNodesWithMedia.map((node, i) => {
        const { imageSrc, videoSrc, customTitle, label } = node.data;
        const mediaSrc = imageSrc || videoSrc;
        const mediaType = imageSrc ? "image" : "video";

        // 确定文件扩展名
        const extension =
          mediaType === "image"
            ? mediaSrc?.includes(".png")
              ? "png"
              : mediaSrc?.includes(".jpg") || mediaSrc?.includes(".jpeg")
                ? "jpg"
                : "png"
            : "mp4";

        const fileName = `${i + 1}-${(customTitle || label).replace(/[/\\?%*:|"<>]/g, "-")}.${extension}`;

        return {
          url: mediaSrc,
          fileName,
          type: mediaType,
        };
      });

      console.log("[Download] Sending download request to backend:", items);

      // 调用后端 API 下载并打包
      const response = await fetch("/api/download-media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "下载失败");
      }

      // 获取 zip 文件
      const blob = await response.blob();
      console.log("[Download] Received zip blob:", blob.size, "bytes");

      if (blob.size === 0) {
        throw new Error("下载的文件为空");
      }

      // 下载 zip 文件
      const downloadUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = `media-export-${new Date().toISOString().slice(0, 10)}-${Date.now()}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(downloadUrl);

      console.log("[Download] Download complete");
    } catch (error) {
      console.error("Failed to download media:", error);
      alert(`下载失败: ${error instanceof Error ? error.message : "请重试"}`);
    } finally {
      setIsDownloading(false);
    }

    onClose();
  };

  const handleAddConnectedNode = (type: NodeType) => {
    if (!node) return;
    const newPosition = {
      x: node.position.x + 400,
      y: node.position.y,
    };

    // 使用新的 addConnectedNode 方法，自动创建节点和连接边
    addConnectedNode(type, nodeId, newPosition);

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
        className="fixed inset-0 z-9998"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />

      {/* 菜单内容 */}
      <div
        style={menuStyle}
        className="min-w-50 rounded-lg border border-gray-700 bg-[#1a1a1a] shadow-2xl"
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

          {/* 批量下载 */}
          {isMultipleSelected && hasMediaToDownload && (
            <button
              onClick={handleDownloadSelected}
              disabled={isDownloading}
              className="flex w-full items-center gap-3 px-4 py-2 text-sm text-gray-200 hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Download
                size={16}
                className={isDownloading ? "animate-pulse" : ""}
              />
              <span>
                {isDownloading
                  ? "打包中..."
                  : `下载选中的媒体 (${selectedNodesWithMedia.length})`}
              </span>
              {!isDownloading && (
                <span className="ml-auto text-xs text-gray-500">Cmd+S</span>
              )}
            </button>
          )}

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
                <div className="absolute left-full top-0 ml-1 hidden min-w-45 rounded-lg border border-gray-700 bg-[#1a1a1a] shadow-2xl group-hover:block">
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
