"use client";

import { useRef, useState } from "react";
import { Loader2, Video } from "lucide-react";
import Image from "next/image";
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
  const [hovered, setHovered] = useState(false);
  const [posterFailed, setPosterFailed] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const poster = ossVideoSnapshotUrl(src);
  const stopHoverPreview = () => {
    const element = video.current;
    if (element) {
      element.pause();
      element.currentTime = 0;
    }
    setHovered(false);
  };
  if (failed) return <p role="alert" className="p-4 text-sm text-zinc-400">原始视频已丢失或无法访问，节点的其他内容仍已保留。</p>;
  return <div
    className="h-full w-full"
    onMouseEnter={() => setHovered(true)}
    onMouseLeave={stopHoverPreview}
  >
    {hovered ? <video
      ref={video}
      src={src}
      aria-label="视频预览"
      autoPlay
      loop
      muted
      playsInline
      preload="auto"
      onError={() => setFailed(true)}
      className="h-full w-full object-contain"
    /> : poster && !posterFailed ? <Image
      src={poster}
      alt="视频封面"
      width={512}
      height={512}
      unoptimized
      draggable={false}
      onError={() => setPosterFailed(true)}
      className="h-full w-full object-contain"
    /> : <div role="img" aria-label="视频封面" className="flex h-full w-full items-center justify-center text-zinc-500">
      <Video size={28} className="opacity-60" aria-hidden />
    </div>}
  </div>;
}

function ossVideoSnapshotUrl(src: string) {
  try {
    const url = new URL(src);
    if (!/(^|\.)aliyuncs\.com$/i.test(url.hostname)) return null;
    const hash = url.hash;
    url.hash = "";
    const separator = url.search ? "&" : "?";
    return `${url.toString()}${separator}x-oss-process=video/snapshot,t_0,f_jpg${hash}`;
  } catch {
    return null;
  }
}
