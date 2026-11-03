"use client";

import { memo, useEffect, useState } from 'react';
import { ExternalLink, RefreshCw, ImageOff, Loader2 } from 'lucide-react';
import { ImagePreview } from './image-preview';
import { canvasExperimentDisabled } from '@/lib/canvas/performance-experiment';

// Share inline-image conversion and object URLs across simultaneously visible thumbnails.
const inline = new Map<string, { promise: Promise<string>; users: number }>();
function acquire(source: string) {
  let entry = inline.get(source);
  if (!entry) {
    const promise = fetch('/api/canvas-preview', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: source })
      .then(response => { if (!response.ok) throw new Error('preview'); return response.blob(); })
      .then(blob => URL.createObjectURL(blob));
    entry = { promise, users: 0 };
    inline.set(source, entry);
    const created = entry;
    void promise.catch(() => { if (inline.get(source) === created) inline.delete(source); });
  }
  entry.users++;
  const current = entry;
  return { promise: current.promise, release() {
    if (--current.users === 0) {
      if (inline.get(source) === current) inline.delete(source);
      void current.promise.then(url => URL.revokeObjectURL(url), () => {});
    }
  } };
}

export const CanvasPreview = memo(function CanvasPreview(props: { src: string; alt: string; className?: string; draggable?: boolean; compact?: boolean }) {
  // A different original must never retain the previous original's preview or error state.
  return <PreviewImage key={props.src} {...props} />;
});

function PreviewImage({ src, alt, className = '', compact = false }: { src: string; alt: string; className?: string; compact?: boolean }) {
  const [inlineUrl, setInlineUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [viewing, setViewing] = useState(false);
  const originalMode = canvasExperimentDisabled('preview');
  const inlineSource = src.startsWith('data:');
  const url = originalMode ? src : inlineSource ? inlineUrl
    : '/api/canvas-preview?src=' + encodeURIComponent(src) + '&retry=' + attempt;
  useEffect(() => {
    if (originalMode || !inlineSource) return;
    let active = true;
    const resource = acquire(src);
    resource.promise.then(value => { if (active) setInlineUrl(value); }, () => { if (active) setFailed(true); });
    return () => { active = false; resource.release(); };
  }, [src, attempt, originalMode, inlineSource]);
  return <span className={`relative inline-block ${className}`} data-canvas-preview="" aria-busy={!loaded && !failed}>
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {url && !failed && <img src={url} alt={alt} draggable={false} decoding="async"
      className={`h-full w-full ${className.includes('object-cover') ? 'object-cover' : 'object-contain'}`}
      onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />}
    {!loaded && !failed && <span className="absolute inset-0 flex items-center justify-center text-xs text-zinc-400">{compact ? <Loader2 size={12} aria-label="预览加载中" /> : "预览加载中…"}</span>}
    {failed && <span className={`nodrag nopan flex h-full items-center justify-center gap-1 text-xs text-zinc-400 ${compact ? "flex-wrap" : "flex-col"}`}>
      {compact ? <ImageOff size={12} aria-label="预览不可用" /> : <span>预览不可用</span>}
      <button type="button" aria-label={`重试预览 ${alt}`} onClick={() => { setFailed(false); setLoaded(false); setInlineUrl(undefined); setAttempt(value => value + 1); }}>{compact ? <RefreshCw size={12} /> : "重试"}</button>
      <button type="button" aria-label={`查看原图 ${alt}`} onClick={() => setViewing(true)}>{compact ? <ExternalLink size={12} /> : "查看原图"}</button>
    </span>}
    {viewing && <ImagePreview src={src} alt={alt} onClose={() => setViewing(false)} />}
  </span>;
}
