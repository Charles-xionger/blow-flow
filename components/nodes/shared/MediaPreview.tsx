"use client";

import React, { useState } from "react";
import { Maximize2, Download, X } from "lucide-react";

interface MediaPreviewProps {
  src: string;
  type: "image" | "video";
  alt?: string;
  onRemove?: () => void;
}

export function MediaPreview({ src, type, alt, onRemove }: MediaPreviewProps) {
  const [isFullscreen, setIsFullscreen] = useState(false);

  const handleDownload = () => {
    const a = document.createElement("a");
    a.href = src;
    a.download = `${type}-${Date.now()}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <>
      <div className="relative group rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800">
        {type === "image" ? (
          <img src={src} alt={alt} className="w-full h-auto" />
        ) : (
          <video src={src} controls className="w-full h-auto" />
        )}

        {/* 悬浮工具栏 */}
        <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
          <button
            onClick={() => setIsFullscreen(true)}
            className="p-2 bg-white/90 rounded-lg hover:bg-white transition-colors"
          >
            <Maximize2 className="w-4 h-4" />
          </button>
          <button
            onClick={handleDownload}
            className="p-2 bg-white/90 rounded-lg hover:bg-white transition-colors"
          >
            <Download className="w-4 h-4" />
          </button>
          {onRemove && (
            <button
              onClick={onRemove}
              className="p-2 bg-red-500/90 text-white rounded-lg hover:bg-red-500 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* 全屏预览 */}
      {isFullscreen && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-8"
          onClick={() => setIsFullscreen(false)}
        >
          {type === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt={alt} className="max-w-full max-h-full" />
          ) : (
            <video src={src} controls className="max-w-full max-h-full" />
          )}
        </div>
      )}
    </>
  );
}
