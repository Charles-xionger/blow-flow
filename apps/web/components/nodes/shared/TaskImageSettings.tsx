'use client';
import { useState } from 'react';
import type { ImageGenerationOptions, PublicModel } from '@/lib/generation/types';
import { resolveImageOptions, transparentBackgroundNeedsAlphaReference } from '@/lib/generation/image-options';
import { ImageSettingsPopover } from './ImageSettingsPopover';
import { consoleSelectClass } from './ConsoleControls';
import styles from './ImageGeneration.module.css';

export function TaskImageSettings({ model, width, height, options: value, canUseTransparency, disabled, onSize, onOptions }: {
  model: PublicModel; width: number; height: number; options?: ImageGenerationOptions; canUseTransparency: boolean; disabled?: boolean;
  onSize: (width: number, height: number) => void; onOptions: (options: ImageGenerationOptions) => void;
}) {
  const image = model.capabilities.image!;
  const presets = image.presets!;
  const selection = presets.find(p => p.width === width && p.height === height);
  const size = selection?.size ?? '2K', ratio = selection?.ratio ?? '1:1';
  const options = resolveImageOptions(value, image);
  const [advanced, setAdvanced] = useState(false);
  const change = (patch: ImageGenerationOptions) => onOptions({ ...options, ...patch });
  return <ImageSettingsPopover summary={selection ? `${size} · ${ratio}` : `${width} × ${height}`} disabled={disabled}
    contentKey={`${width}:${height}:${advanced}:${JSON.stringify(options)}`}>
    <div className={styles.label}>尺寸档位</div>
    <div className={styles.chips}>{image.sizes.map(value => <button key={value} className={styles.chip} aria-pressed={size === value} disabled={!presets.some(p => p.size === value && p.ratio === ratio)}
      onClick={() => { const preset = presets.find(p => p.size === value && p.ratio === ratio); if (preset) onSize(preset.width, preset.height); }}>{value}</button>)}</div>
    <div className={styles.label}>画幅</div>
    <div className={styles.ratios}>{image.aspectRatios.map(value => <button key={value} className={styles.ratio} aria-pressed={ratio === value} disabled={!presets.some(p => p.size === size && p.ratio === value)}
      onClick={() => { const preset = presets.find(p => p.size === size && p.ratio === value); if (preset) onSize(preset.width, preset.height); }}>{value}</button>)}</div>
    <div className={styles.actual}>{width} × {height} px</div>
    <button type="button" className={styles.label} aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>高级设置</button>
    {advanced && <div className="flex flex-col gap-3">
      <label>图片格式 <select aria-label="图片格式" className={consoleSelectClass} value={options.outputFormat}
        onChange={e => change({ outputFormat: e.target.value as 'png' | 'jpeg', ...(e.target.value === 'jpeg' ? { background: 'opaque' } : {}) })}>
        {image.options?.outputFormats.map(format => <option key={format} value={format}>{format.toUpperCase()}</option>)}
      </select></label>
      <label>提示词优化 <select aria-label="提示词优化" className={consoleSelectClass} value={options.promptOptimization}
        onChange={e => change({ promptOptimization: e.target.value as 'standard' | 'fast' })}>
        {image.options?.promptOptimizations.map(mode => <option key={mode} value={mode}>{mode === 'standard' ? '标准' : '快速'}</option>)}
      </select></label>
      <label><input type="checkbox" checked={options.watermark} disabled={!image.options?.watermark && !options.watermark} onChange={e => change({ watermark: e.target.checked })} /> 可见水印</label>
      <label><input type="checkbox" checked={options.background === 'transparent'} disabled={options.background !== 'transparent' && (!image.options?.transparentBackground ||
        (transparentBackgroundNeedsAlphaReference(image) && !canUseTransparency) || options.outputFormat !== 'png')}
        onChange={e => change({ background: e.target.checked ? 'transparent' : 'opaque' })} /> 透明背景</label>
      <p className={styles.hint}>{!transparentBackgroundNeedsAlphaReference(image)
        ? '可原生生成透明背景，输出格式为 PNG。'
        : '透明背景需要一张带透明通道的参考图，输出格式为 PNG。'}</p>
    </div>}
  </ImageSettingsPopover>;
}
