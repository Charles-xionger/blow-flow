"use client";

import { Download, Expand, X, ZoomIn, ZoomOut } from "lucide-react";
import { useState, useEffect } from "react";
import { createPortal } from "react-dom";

interface ImageWithActionsProps {
  src: string | undefined;
  alt?: string;
  className?: string;
}

export function ImageWithActions({
  src,
  alt = "图片",
  className = "",
}: ImageWithActionsProps) {
  const [showPreview, setShowPreview] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    if (showPreview) {
      const handleEscape = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          setShowPreview(false);
        }
      };
      window.addEventListener("keydown", handleEscape);
      return () => window.removeEventListener("keydown", handleEscape);
    }
  }, [showPreview]);

  // 重置缩放比例当关闭预览时
  useEffect(() => {
    if (!showPreview) {
      setScale(1);
    }
  }, [showPreview]);

  if (!src) return null;

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();

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
  };

  const handlePreview = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowPreview(true);
  };

  const handleZoomIn = (e: React.MouseEvent) => {
    e.stopPropagation();
    setScale((prev) => Math.min(prev + 0.25, 3)); // 最大3倍
  };

  const handleZoomOut = (e: React.MouseEvent) => {
    e.stopPropagation();
    setScale((prev) => Math.max(prev - 0.25, 0.1)); // 最小0.1倍
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
          </div>
        )}
      </div>

      {/* 预览弹窗 - 使用 Portal 渲染到 body */}
      {showPreview &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/90 backdrop-blur-sm"
            onClick={() => setShowPreview(false)}
          >
            {/* 关闭按钮 */}
            <button
              onClick={() => setShowPreview(false)}
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
        )}
    </>
  );
}
