"use client";

import { useState } from 'react';
import { ImageSettingsPopover } from './ImageSettingsPopover';
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
  const [notice, setNotice] = useState('');
  const selection = imageSizeSelection(width, height, limits, preference);
  const ratio = selection.ratio ?? '1:1';
  return <ImageSettingsPopover disabled={disabled}
    summary={`${selection.preset === 'custom' ? '自定义' : selection.preset.toUpperCase()} · ${selection.label}`}
    contentKey={`${width}:${height}:${selection.preset}:${notice}`}>
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
  </ImageSettingsPopover>;
}
