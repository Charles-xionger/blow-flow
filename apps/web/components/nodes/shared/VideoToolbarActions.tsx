"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Download, Expand } from "lucide-react";
import { downloadVideo } from "@/components/ui/media-actions";
import { NodeToolbarButton } from "../NodeShell";

function VideoPreview({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Closing the preview must not also reach xyflow, which would deselect the node.
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-10000 flex items-center justify-center bg-black/90 p-8 backdrop-blur-sm" onClick={onClose}>
      <video src={src} controls autoPlay className="max-h-full max-w-full" onClick={event => event.stopPropagation()} />
    </div>,
    document.body,
  );
}

/** Actions on a video result; all are unavailable until the node has one. */
export function VideoToolbarActions({ src }: { src?: string }) {
  const [previewing, setPreviewing] = useState(false);
  return <>
    <NodeToolbarButton label="预览" icon={Expand} disabled={!src} onClick={() => setPreviewing(true)} />
    <NodeToolbarButton label="下载" icon={Download} disabled={!src} onClick={() => { if (src) void downloadVideo(src); }} />
    {src && previewing && <VideoPreview src={src} onClose={() => setPreviewing(false)} />}
  </>;
}
