"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useViewport } from '@xyflow/react';
import { ChevronDown, X } from 'lucide-react';
import { imageAspectRatios, imagePresetDimensions, imageSizeSelection, normalizeImageDimension,
  type DimensionLimits, type ImageDimensions, type ImageSizePreset } from '@/lib/generation/image-dimensions';
import styles from './ImageGeneration.module.css';

interface Props extends ImageDimensions {
  limits: DimensionLimits;
  preference?: ImageSizePreset;
  disabled?: boolean;
  onChange: (size: ImageDimensions, preset: ImageSizePreset) => void;
}

function DimensionInput({ label, value, limits, onCommit }: {
  label: string; value: number; limits: DimensionLimits; onCommit: (value: number, message: string) => void;
}) {
  const [raw, setRaw] = useState(String(value));
  const commit = () => {
    const next = normalizeImageDimension(raw, value, limits);
    setRaw(String(next));
    const changed = !raw.trim() || Number(raw) !== next;
    onCommit(next, changed ? `${label}已${!raw.trim() || !Number.isFinite(Number(raw)) ? '恢复为' : '调整为'} ${next} px` : '');
  };
  return <label>{label}<input aria-label={`生成${label}度`} type="number" inputMode="numeric"
    min={limits.min} max={limits.max} step={limits.step} value={raw}
    onChange={event => setRaw(event.target.value)} onBlur={commit}
    onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.blur(); } }} />
  </label>;
}

export function ImageSizeSettings({ width, height, limits, preference, disabled, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [position, setPosition] = useState({ left: 16, top: 16, maxHeight: 600 });
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const dialogId = useId();
  const viewport = useViewport();
  const selection = imageSizeSelection(width, height, limits, preference);
  const ratio = selection.ratio ?? '1:1';
  const close = () => { setOpen(false); trigger.current?.focus(); };

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!trigger.current || !content.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const maxHeight = window.innerHeight - 32;
      const popupHeight = Math.min(content.current.scrollHeight + 2, maxHeight);
      const popupWidth = content.current.getBoundingClientRect().width;
      const top = anchor.top >= popupHeight + 24 ? anchor.top - popupHeight - 8 : anchor.bottom + 8;
      setPosition({ left: Math.max(16, Math.min(anchor.left, window.innerWidth - popupWidth - 16)),
        top: Math.max(16, Math.min(top, window.innerHeight - popupHeight - 16)), maxHeight });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, viewport.x, viewport.y, viewport.zoom, width, height, selection.preset, notice]);

  useEffect(() => {
    if (!open) return;
    content.current?.focus();
    // Click follows input blur, so closing the popover cannot discard an uncommitted dimension.
    const outside = (event: MouseEvent) => {
      if (!content.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener('click', outside, true);
    document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('click', outside, true); document.removeEventListener('keydown', escape, true); };
  }, [open]);

  return <>
    <button ref={trigger} type="button" className={styles.pill} aria-label="图像设置" aria-haspopup="dialog"
      aria-expanded={open} aria-controls={open ? dialogId : undefined} disabled={disabled}
      onClick={() => { setNotice(''); setOpen(value => !value); }}>
      {selection.preset === 'custom' ? '自定义' : selection.preset.toUpperCase()} · {selection.label}<ChevronDown size={14} />
    </button>
    {open && !disabled && createPortal(<div ref={content} id={dialogId} role="dialog" aria-label="图像设置" tabIndex={-1}
      className={`${styles.settings} nodrag nopan nowheel`} style={position}
      onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
      <div className={styles.heading}>图像设置<button className={styles.close} aria-label="关闭图像设置" onClick={close}><X size={16} /></button></div>
      <div className={styles.label}>尺寸档位</div>
      <div className={styles.chips}>
        {(['1k', '2k', 'custom'] as const).map(preset => <button key={preset} className={styles.chip}
          aria-pressed={selection.preset === preset} disabled={preset !== 'custom' && !imagePresetDimensions(preset, ratio, limits)}
          onClick={() => {
            setNotice('');
            const size = preset === 'custom' ? { width, height } : imagePresetDimensions(preset, ratio, limits);
            if (size) onChange(size, preset);
          }}>{preset === 'custom' ? '自定义' : preset.toUpperCase()}</button>)}
      </div>
      {selection.preset === 'custom' ? <>
        <div className={styles.label}>自定义尺寸</div>
        <div className={styles.dimensions}>
          <DimensionInput key={`width-${width}`} label="宽" value={width} limits={limits}
            onCommit={(value, message) => { setNotice(message); onChange({ width: value, height }, 'custom'); }} />
          <DimensionInput key={`height-${height}`} label="高" value={height} limits={limits}
            onCommit={(value, message) => { setNotice(message); onChange({ width, height: value }, 'custom'); }} />
        </div>
        <p className={styles.hint}>每边 {limits.min}–{limits.max} px，按 {limits.step} 像素对齐。</p>
      </> : <>
        <div className={styles.label}>画幅</div>
        <div className={styles.ratios}>
          {imageAspectRatios.map(value => {
            const [w, h] = value.split(':').map(Number);
            const size = imagePresetDimensions(selection.preset as '1k' | '2k', value, limits);
            return <button key={value} className={styles.ratio} aria-pressed={selection.ratio === value} disabled={!size}
              onClick={() => { setNotice(''); if (size) onChange(size, selection.preset); }}>
              <span aria-hidden className={styles.shape} style={{ width: 18 * w / Math.max(w, h), height: 18 * h / Math.max(w, h) }} />{value}
            </button>;
          })}
        </div>
        <p className={styles.hint}>1K / 2K 以短边为基准，实际尺寸按 {limits.step} 像素对齐。</p>
      </>}
      <p className={styles.actual}>实际生成尺寸：{width} × {height} px</p>
      {notice && <p role="status" className={styles.notice}>{notice}</p>}
    </div>, document.body)}
  </>;
}
