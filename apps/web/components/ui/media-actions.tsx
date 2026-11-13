"use client";

import { User } from "lucide-react";
import { CanvasPreview } from "./canvas-preview";
export { ImagePreview } from "./image-preview";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export const downloadImage = (src: string) => downloadFile(src, `image-${Date.now()}.png`);
export const downloadVideo = (src: string) => downloadFile(src, `video-${Date.now()}.mp4`);

async function downloadFile(src: string, filename: string) {
  try {
    // 如果是 data URL 或 blob URL，直接使用
    if (src.startsWith("data:") || src.startsWith("blob:")) {
      const link = document.createElement("a");
      link.href = src;
      link.download = filename;
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
    link.download = filename;
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
      link.download = filename;
      link.target = "_blank";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (fallbackError) {
      console.error("降级下载也失败:", fallbackError);
      alert("下载失败，请右键点击另存为");
    }
  }
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
          <CanvasPreview
            src={src}
            alt={alt}
            className="h-60 w-full rounded-lg border border-zinc-700"
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
