"use client";

import { Image as ImageIcon, Loader2 } from "lucide-react";
import type { NodeData } from "@/types";

/** Stage of an image generation node: the result or an empty mark, with progress on top. */
export function ImageStage({ data }: { data: NodeData }) {
  return <>
    {data.imageSrc && !data.isLoading ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={data.imageSrc} alt="Generated" draggable={false} className="w-full h-full object-contain" />
    ) : (
      <div role="img" aria-label="尚无生成图片" className="w-full h-full flex items-center justify-center text-zinc-500">
        <div className="w-16 h-16 rounded-2xl flex items-center justify-center bg-zinc-800/50 text-zinc-500">
          <ImageIcon size={28} className="opacity-60" aria-hidden />
        </div>
      </div>
    )}
    {data.isLoading && (
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex flex-col items-center justify-center z-20">
        <Loader2 size={32} className="text-blue-500 animate-spin mb-3" />
        <span className="text-white/80 text-sm font-medium">{data.generationTaskId ? data.generationStatus : "生成中..."}</span>
      </div>
    )}
  </>;
}
