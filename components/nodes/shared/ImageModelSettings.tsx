"use client";

import { ImageSettingsPopover } from './ImageSettingsPopover';
import styles from './ImageGeneration.module.css';

type Choice = { value: string; label: string };

/** Existing API models keep their own option values; only the presentation is shared. */
export function ImageModelSettings({ aspectRatio, resolution, ratios, resolutions, disabled, onChange }: {
  aspectRatio: string; resolution: string; ratios: readonly Choice[]; resolutions: readonly Choice[];
  disabled?: boolean; onChange: (settings: { aspectRatio?: string; resolution?: string }) => void;
}) {
  const current = resolutions.find(option => option.value === resolution)
    ?? resolutions.find(option => option.label.toLowerCase() === resolution.toLowerCase());
  return <ImageSettingsPopover summary={`${current?.label ?? resolution} · ${aspectRatio}`}
    contentKey={`${resolution}:${aspectRatio}`} disabled={disabled}>
    <div className={styles.label}>尺寸档位</div>
    <div className={styles.chips}>
      {resolutions.map(option => <button key={option.value} className={styles.chip}
        aria-pressed={option === current} onClick={() => onChange({ resolution: option.value })}>{option.label}</button>)}
    </div>
    <div className={styles.label}>画幅</div>
    <div className={styles.ratios}>
      {ratios.map(option => {
        const [w, h] = option.value.split(':').map(Number);
        return <button key={option.value} className={styles.ratio} aria-pressed={option.value === aspectRatio}
          onClick={() => onChange({ aspectRatio: option.value })}>
          <span aria-hidden className={styles.shape} style={{ width: 18 * w / Math.max(w, h), height: 18 * h / Math.max(w, h) }} />
          {option.value}
        </button>;
      })}
    </div>
  </ImageSettingsPopover>;
}
