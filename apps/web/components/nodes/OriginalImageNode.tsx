"use client";

import { nodeContentEqual } from "@/lib/canvas/node-content";

import { CanvasPreview } from "@/components/ui/canvas-preview";

import { memo, useCallback, useEffect, useRef } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { Image as ImageIcon, Trash2, Upload, X } from "lucide-react";
import { mediaUploadLimit } from "@/lib/upload-limits";
import { useCanvasStore } from "@/store/useCanvasStore";
import type { NodeData } from "@/types";
import { NodeShell, NodeToolbarButton } from "./NodeShell";
import { ImageToolbarActions } from "./shared/ImageToolbarActions";

const OriginalImageNode = (props: NodeProps<Node<NodeData>>) => {
  const { id, data, selected } = props;
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const upload = useCallback(async (file: File) => {
    if (file.size > mediaUploadLimit) {
      updateNodeData(id, { error: "图片大小不能超过 30 MB", isLoading: false });
      return;
    }

    const complete = useCanvasStore.getState().beginMediaOperation(id);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch("/api/upload/image", { method: "POST", body: formData });
      const result = await response.json();
      if (!result.success) throw new Error(result.error);
      // 使用永久 URL
      complete({ imageSrc: result.data.url, isLoading: false, error: undefined });
    } catch (error) {
      console.error("Upload failed:", error);
      complete({ error: error instanceof Error ? error.message : "上传失败", isLoading: false });
    }
  }, [id, updateNodeData]);

  // 选中时粘贴图片即上传
  useEffect(() => {
    if (!selected) return;
    const handlePaste = (event: ClipboardEvent) => {
      const file = Array.from(event.clipboardData?.items ?? [])
        .find((item) => item.type.startsWith("image/"))?.getAsFile();
      if (!file) return;
      event.preventDefault();
      void upload(file);
    };
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [selected, upload]);

  // While the stage shows progress or an error, actions on the image are unavailable.
  const src = data.isLoading || data.error ? undefined : data.imageSrc;

  return (
    <NodeShell {...props}
      toolbar={<>
        <input ref={fileInputRef} type="file" accept="image/*" className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void upload(file);
          }} />
        <NodeToolbarButton label={data.imageSrc ? "重新上传" : "上传图片"} icon={Upload} disabled={data.isLoading}
          onClick={() => fileInputRef.current?.click()} />
        <ImageToolbarActions nodeId={id} src={src} alt="Uploaded image" />
        <NodeToolbarButton label="删除图片" icon={Trash2} disabled={data.isLoading || (!data.imageSrc && !data.error)}
          onClick={() => updateNodeData(id, { imageSrc: undefined, error: undefined })} />
      </>}
    >
      {data.isLoading ? (
        <div className="w-full h-full flex flex-col items-center justify-center text-zinc-500">
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4 bg-zinc-800/50">
            <div className="w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
          </div>
          <span className="text-sm font-medium opacity-60">上传中...</span>
        </div>
      ) : data.error ? (
        <div className="w-full h-full flex flex-col items-center justify-center text-red-500">
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4 bg-red-500/10">
            <X size={28} className="opacity-60" />
          </div>
          <span className="text-sm font-medium opacity-60">上传失败</span>
          <span className="text-xs opacity-40 mt-1">{data.error}</span>
        </div>
      ) : data.imageSrc ? (
            <CanvasPreview src={data.imageSrc} alt="Uploaded image" draggable={false} className="w-full h-full object-contain" />
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center text-zinc-500">
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4 bg-zinc-800/50 text-zinc-500">
            <ImageIcon size={28} className="opacity-60" />
          </div>
          <span className="text-sm font-medium opacity-60">原图</span>
          <span className="text-xs opacity-40 mt-1">选中节点后上传或粘贴图片</span>
          <span className="text-xs opacity-40 mt-1">支持 JPG、PNG、WEBP、GIF 格式，最大 30 MB</span>
        </div>
      )}
    </NodeShell>
  );
};

OriginalImageNode.displayName = "OriginalImageNode";

export default memo(OriginalImageNode, nodeContentEqual);
