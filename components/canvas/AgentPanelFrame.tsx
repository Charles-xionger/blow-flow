'use client';

import { useEffect, useRef, useState, type ReactNode, type PointerEvent } from 'react';
import { GripHorizontal, Maximize2, Minimize2, PanelRight, PanelsTopLeft, Sparkles, X } from 'lucide-react';
import styles from './AgentSidebar.module.css';

type Position = { x: number; y: number };
const preferenceKey = 'ai-flow:assistant-layout';

export function AgentPanelFrame({ children, close }: { children: ReactNode; close: () => void }) {
  const [mode, setMode] = useState<'docked' | 'floating'>('docked');
  const [expanded, setExpanded] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const panel = useRef<HTMLElement>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; origin: Position } | null>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      try { if (localStorage.getItem(preferenceKey) === 'floating') setMode('floating'); } catch { /* Storage is optional. */ }
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  // Keep the entire floating panel reachable after a window resize or width change.
  useEffect(() => {
    const clamp = () => {
      const el = panel.current;
      if (!el || mode !== 'floating') return;
      const bounds = el.getBoundingClientRect();
      setPosition({ x: Math.max(8, Math.min(bounds.x, window.innerWidth - bounds.width - 8)), y: Math.max(64, Math.min(bounds.y, window.innerHeight - bounds.height - 8)) });
    };
    const frame = requestAnimationFrame(clamp);
    window.addEventListener('resize', clamp);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', clamp); };
  }, [expanded, mode]);

  function toggleMode() {
    const next = mode === 'docked' ? 'floating' : 'docked';
    setMode(next);
    try { localStorage.setItem(preferenceKey, next); } catch { /* Storage is optional. */ }
  }
  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (mode !== 'floating' || event.button !== 0 || !panel.current) return;
    const bounds = panel.current.getBoundingClientRect();
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, origin: { x: bounds.x, y: bounds.y } };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId || !panel.current) return;
    setPosition({
      x: Math.max(8, Math.min(active.origin.x + event.clientX - active.x, window.innerWidth - panel.current.offsetWidth - 8)),
      y: Math.max(64, Math.min(active.origin.y + event.clientY - active.y, window.innerHeight - panel.current.offsetHeight - 8)),
    });
  }

  return <aside ref={panel} aria-label="创作助手对话" className={styles.panel} data-mode={mode} data-expanded={expanded}
    style={mode === 'floating' && position ? { left: position.x, top: position.y, right: 'auto' } : undefined}
    onKeyDown={event => event.stopPropagation()}>
    <header className={styles.header}>
      <div className={styles.identity} data-draggable={mode === 'floating'} title={mode === 'floating' ? '拖动以移动助手' : undefined}
        onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
        <span className={styles.logo}><Sparkles size={18}/></span>
        <div><strong>创作助手</strong><span className={styles.subtitle}>{mode === 'floating' ? '浮动窗口 · 拖动标题栏移动' : '从灵感到画布，陪你一起创作'}</span></div>
        {mode === 'floating' && <GripHorizontal size={14} className={styles.dragIcon}/>}
      </div>
      <div className={styles.actions}>
        <button aria-label={mode === 'docked' ? '切换为浮动窗口' : '停靠到右侧'} title={mode === 'docked' ? '切换为浮动窗口' : '停靠到右侧'} onClick={toggleMode}>{mode === 'docked' ? <PanelsTopLeft size={16}/> : <PanelRight size={16}/>}</button>
        <button aria-label={expanded ? '收起宽屏' : '展开宽屏'} title={expanded ? '收起宽屏' : '展开宽屏'} onClick={() => setExpanded(!expanded)}>{expanded ? <Minimize2 size={16}/> : <Maximize2 size={16}/>}</button>
        <button aria-label="关闭创作助手" title="关闭创作助手" onClick={close}><X size={18}/></button>
      </div>
    </header>
    {children}
  </aside>;
}
