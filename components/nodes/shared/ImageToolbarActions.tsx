"use client";

import { useState } from "react";
import { Download, Expand, User } from "lucide-react";
import { toast } from "sonner";
import { ImagePreview, SaveAsCharacterDialog, downloadImage } from "@/components/ui/media-actions";
import { expandPrompt } from "@/lib/canvas/prompt";
import { useCanvasStore } from "@/store/useCanvasStore";
import { NodeToolbarButton } from "../NodeShell";

async function saveAsCharacter(nodeId: string, src: string) {
  const toastId = toast.loading("正在分析图片...");
  try {
    const analyzeResponse = await fetch("/api/character/analyze-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageUrl: src, prompt: expandPrompt(nodeId, useCanvasStore.getState()) }),
    });
    const analyzeResult = await analyzeResponse.json();
    if (!analyzeResult.success) throw new Error(analyzeResult.error);

    toast.loading("正在保存角色...", { id: toastId });
    const saveResponse = await fetch("/api/character", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: analyzeResult.data.name,
        description: analyzeResult.data.description,
        referenceImages: [src],
        tags: analyzeResult.data.tags || [],
      }),
    });
    const saveResult = await saveResponse.json();
    if (!saveResult.success) throw new Error(saveResult.error || "保存失败");

    toast.success(`角色"${analyzeResult.data.name}"已保存！`, { id: toastId });
    // 触发角色库刷新事件
    window.dispatchEvent(new CustomEvent("characterSaved"));
  } catch (error) {
    console.error("Failed to save character:", error);
    toast.error(`保存失败: ${error instanceof Error ? error.message : "未知错误"}`, { id: toastId });
  }
}

/** Actions on an image result; all are unavailable until the node has one. */
export function ImageToolbarActions({ nodeId, src, alt }: { nodeId: string; src?: string; alt?: string }) {
  const [dialog, setDialog] = useState<"preview" | "character">();
  const close = () => setDialog(undefined);
  return <>
    <NodeToolbarButton label="预览" icon={Expand} disabled={!src} onClick={() => setDialog("preview")} />
    <NodeToolbarButton label="下载" icon={Download} disabled={!src} onClick={() => { if (src) void downloadImage(src); }} />
    <NodeToolbarButton label="保存为角色" icon={User} disabled={!src} onClick={() => setDialog("character")} />
    {src && dialog === "preview" && <ImagePreview src={src} alt={alt} onClose={close} />}
    {src && dialog === "character" && <SaveAsCharacterDialog src={src} alt={alt} onClose={close} onConfirm={() => saveAsCharacter(nodeId, src)} />}
  </>;
}
