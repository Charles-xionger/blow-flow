"use client";

import { useState } from "react";
import { Download, Expand, User } from "lucide-react";
import { ImagePreview, SaveAsCharacterDialog, downloadImage } from "@/components/ui/image-with-actions";
import { NodeToolbarButton } from "../NodeShell";

/** Actions on an image result; all are unavailable until the node has one. */
export function ImageToolbarActions({ src, alt, onSaveAsCharacter }: {
  src?: string;
  alt?: string;
  onSaveAsCharacter: () => void | Promise<void>;
}) {
  const [dialog, setDialog] = useState<"preview" | "character">();
  const close = () => setDialog(undefined);
  return <>
    <NodeToolbarButton label="预览" icon={Expand} disabled={!src} onClick={() => setDialog("preview")} />
    <NodeToolbarButton label="下载" icon={Download} disabled={!src} onClick={() => { if (src) void downloadImage(src); }} />
    <NodeToolbarButton label="保存为角色" icon={User} disabled={!src} onClick={() => setDialog("character")} />
    {src && dialog === "preview" && <ImagePreview src={src} alt={alt} onClose={close} />}
    {src && dialog === "character" && <SaveAsCharacterDialog src={src} alt={alt} onClose={close} onConfirm={onSaveAsCharacter} />}
  </>;
}
