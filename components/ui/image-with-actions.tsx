"use client";

import { Download, Expand, X, ZoomIn, ZoomOut, User } from "lucide-react";
import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface ImageWithActionsProps {
  src: string | undefined;
  alt?: string;
  className?: string;
  onSaveAsCharacter?: () => void | Promise<void>;
}

export async function downloadImage(src: string) {
  try {
    // 如果是 data URL 或 blob URL，直接使用
    if (src.startsWith("data:") || src.startsWith("blob:")) {
      const link = document.createElement("a");
      link.href = src;
      link.download = `image-${Date.now()}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      return;
    }

    // 对于远程 URL，尝试使用 fetch
    const response = await fetch(src, {
      mode: "cors",
      credentials: "omit",
    });

    if (!response.ok) {
      throw new Error("下载失败");
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `image-${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  } catch (error) {
    console.error("下载失败:", error);
    // 降级方案：直接打开链接
    try {
      const link = document.createElement("a");
      link.href = src;
      link.download = `image-${Date.now()}.png`;
      link.target = "_blank";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (fallbackError) {
      console.error("降级下载也失败:", fallbackError);
      alert("下载失败，请右键点击图片另存为");
    }
  }
}

export function ImagePreview({ src, alt = "图片", onClose }: {
  src: string;
  alt?: string;
  onClose: () => void;
}) {
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Closing the preview must not also reach xyflow, which would deselect the node.
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [onClose]);

  const handleZoomIn = (e: React.MouseEvent) => {
    e.stopPropagation();
    setScale((prev) => Math.min(prev + 0.25, 3)); // 最大3倍
  };

  const handleZoomOut = (e: React.MouseEvent) => {
    e.stopPropagation();
    setScale((prev) => Math.max(prev - 0.25, 0.1)); // 最小0.1倍
  };

  return createPortal(
    <div
      className="fixed inset-0 z-10000 flex items-center justify-center bg-black/90 backdrop-blur-sm"
      onClick={() => onClose()}
    >
      {/* 关闭按钮 */}
      <button
        onClick={() => onClose()}
        className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors z-10"
      >
        <X size={24} />
      </button>

      {/* 缩放控制按钮 */}
      <div className="absolute bottom-4 right-4 flex flex-col gap-2 z-10">
        <button
          onClick={handleZoomIn}
          className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
          title="放大"
        >
          <ZoomIn size={20} />
        </button>
        <div className="px-3 py-1 rounded-full bg-white/10 text-white text-sm text-center">
          {Math.round(scale * 100)}%
        </div>
        <button
          onClick={handleZoomOut}
          className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
          title="缩小"
        >
          <ZoomOut size={20} />
        </button>
      </div>

      <div
        className="max-w-[90vw] max-h-[90vh] overflow-auto relative"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={src}
          alt={alt}
          className="w-full h-full object-contain transition-transform duration-200"
          style={{ transform: `scale(${scale})` }}
        />
      </div>
    </div>,
    document.body,
  );
}

export function SaveAsCharacterDialog({ src, alt = "图片", onClose, onConfirm }: {
  src: string;
  alt?: string;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="sm:max-w-md" onKeyDown={(e) => e.stopPropagation()}>
      <DialogHeader>
        <DialogTitle>保存为角色</DialogTitle>
        <DialogDescription>
          将此图片保存为角色，AI 将自动分析图片中的角色特征并生成角色信息。
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-4 py-4">
        <div className="flex items-center justify-center">
          <img
            src={src}
            alt={alt}
            className="max-w-full max-h-60 rounded-lg border border-zinc-700"
          />
        </div>
        <p className="text-sm text-gray-400">
          点击确认后，系统将使用 AI
          分析图片，提取角色的外貌、风格等特征信息。
        </p>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onClose()}>
          取消
        </Button>
        <Button
          onClick={async () => {
            onClose();
            await onConfirm();
          }}
          className="bg-purple-600 hover:bg-purple-700"
        >
          <User className="w-4 h-4 mr-2" />
          保存为角色
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
  );
}

export function ImageWithActions({
  src,
  alt = "图片",
  className = "",
  onSaveAsCharacter,
}: ImageWithActionsProps) {
  const [showPreview, setShowPreview] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);

  if (!src) return null;

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    await downloadImage(src);
  };

  const handlePreview = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowPreview(true);
  };

  return (
    <>
      <div
        className="relative w-full h-full group"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <img src={src} alt={alt} className={className} />

        {/* 工具菜单 */}
        {isHovered && (
          <div
            className="absolute right-2 top-1/2 -translate-y-1/2 flex flex-col gap-2 z-50 pointer-events-auto"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              onClick={handlePreview}
              onMouseDown={(e) => e.stopPropagation()}
              className="p-2 rounded-lg bg-black/80 hover:bg-black text-white backdrop-blur-sm transition-all hover:scale-110 cursor-pointer"
              title="预览"
            >
              <Expand size={16} />
            </button>
            <button
              onClick={handleDownload}
              onMouseDown={(e) => e.stopPropagation()}
              className="p-2 rounded-lg bg-black/80 hover:bg-black text-white backdrop-blur-sm transition-all hover:scale-110 cursor-pointer"
              title="下载"
            >
              <Download size={16} />
            </button>
            {onSaveAsCharacter && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowSaveDialog(true);
                }}
                onMouseDown={(e) => e.stopPropagation()}
                className="p-2 rounded-lg bg-purple-600/80 hover:bg-purple-600 text-white backdrop-blur-sm transition-all hover:scale-110 cursor-pointer"
                title="保存为角色"
              >
                <User size={16} />
              </button>
            )}
          </div>
        )}
      </div>

      {showPreview && typeof document !== "undefined" && (
        <ImagePreview src={src} alt={alt} onClose={() => setShowPreview(false)} />
      )}

      {showSaveDialog && onSaveAsCharacter && (
        <SaveAsCharacterDialog src={src} alt={alt} onClose={() => setShowSaveDialog(false)} onConfirm={onSaveAsCharacter} />
      )}
    </>
  );
}
