"use client";

import { useState } from "react";
import { Loader2, Video } from "lucide-react";
import type { NodeData } from "@/types";

/** Stage of a video generation node: the player or an empty mark, with progress on top. */
export function VideoStage({ data, emptyLabel }: { data: NodeData; emptyLabel: string }) {
  return <>
    {data.videoSrc && !data.isLoading ? (
      <OriginalVideo key={data.videoSrc} src={data.videoSrc} />
    ) : (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-zinc-500">
        <Video size={28} className="opacity-60" aria-hidden />
        <span className="text-sm font-medium opacity-60">{emptyLabel}</span>
      </div>
    )}
    {data.isLoading && (
      <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/60 backdrop-blur-sm">
        <Loader2 size={32} className="mb-3 animate-spin text-blue-500" />
        <span className="text-sm font-medium text-white/80">{data.generationStatus || "生成中..."}</span>
      </div>
    )}
  </>;
}

function OriginalVideo({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? <p role="alert" className="p-4 text-sm text-zinc-400">原始视频已丢失或无法访问，节点的其他内容仍已保留。</p>
    : <video src={src} onError={() => setFailed(true)} controls loop preload="metadata" className="h-full w-full object-contain" />;
}
