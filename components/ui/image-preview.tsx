"use client";

import { X, ZoomIn, ZoomOut } from "lucide-react";
import { useState, useEffect } from "react";
import { createPortal } from "react-dom";

type ImagePreviewProps = { src: string; alt?: string; onClose: () => void };

export function ImagePreview(props: ImagePreviewProps) {
  return <ImagePreviewContent key={props.src} {...props} />;
}

function ImagePreviewContent({ src, alt = "图片", onClose }: ImagePreviewProps) {
  const [scale, setScale] = useState(1);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

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
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}
    >
      {/* 关闭按钮 */}
      <button
        aria-label="关闭图片预览"
        onClick={(event) => { event.stopPropagation(); onClose(); }}
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
        {/* Full viewing deliberately loads the original material. */}
        {!loaded && !failed && <p role="status" className="p-6 text-sm text-white">正在加载原图…</p>}
        {failed && <p role="alert" className="p-6 text-sm text-white">原始素材已丢失或无法访问，节点的其他内容仍已保留。</p>}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          src={src}
          alt={alt}
          className="block max-w-[90vw] max-h-[90vh] w-auto h-auto object-contain transition-transform duration-200"
          style={{ transform: `scale(${scale})` }}
        />
      </div>
    </div>,
    document.body,
  );
}
