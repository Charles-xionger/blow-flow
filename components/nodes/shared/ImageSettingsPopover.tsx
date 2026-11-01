"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useViewport } from '@xyflow/react';
import { ChevronDown, X } from 'lucide-react';
import styles from './ImageGeneration.module.css';

/** Shared parameter popover; model capabilities determine only its contents. */
export function ImageSettingsPopover({ summary, contentKey, disabled, children }: {
  summary: string; contentKey: string; disabled?: boolean; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 16, top: 16, maxHeight: 600 });
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const dialogId = useId();
  const viewport = useViewport();
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
  }, [open, viewport.x, viewport.y, viewport.zoom, contentKey]);

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
      onClick={() => setOpen(value => !value)}>
      {summary}<ChevronDown size={14} />
    </button>
    {open && !disabled && createPortal(<div ref={content} id={dialogId} role="dialog" aria-label="图像设置" tabIndex={-1}
      className={`${styles.settings} nodrag nopan nowheel`} style={position}
      onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
      <div className={styles.heading}>图像设置<button className={styles.close} aria-label="关闭图像设置" onClick={close}><X size={16} /></button></div>
      {children}
    </div>, document.body)}
  </>;
}
