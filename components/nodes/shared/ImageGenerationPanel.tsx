"use client";

import type { ReactNode } from 'react';
import styles from './ImageGeneration.module.css';

/** All image models use the same node-local panel, including canvas zoom and spacing. */
export function ImageGenerationPanel({ children }: { children: ReactNode }) {
  return <div className="node-panel nodrag nopan nowheel absolute top-full left-1/2 -translate-x-1/2 pt-4 z-70 pointer-events-auto"
    onMouseDown={event => event.stopPropagation()}>
    <div data-testid="image-generation-panel" className={styles.panel}>{children}</div>
  </div>;
}
