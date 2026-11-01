"use client";

import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { NodeToolbar, Position, useInternalNode, useViewport } from '@xyflow/react';

/** Screen-sized controls follow the node without scaling text or leaving the viewport. */
export function ImageGenerationPanel({ nodeId, children }: { nodeId: string; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const offset = useRef({ x: 0, y: 0 });
  const node = useInternalNode(nodeId);
  const viewport = useViewport();
  const x = node?.internals.positionAbsolute.x;
  const y = node?.internals.positionAbsolute.y;
  const width = node?.measured.width;
  const height = node?.measured.height;

  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const place = () => {
      const box = element.getBoundingClientRect();
      const left = box.left - offset.current.x;
      const top = box.top - offset.current.y;
      const next = {
        x: Math.max(16, Math.min(left, window.innerWidth - box.width - 16)) - left,
        y: Math.max(16, Math.min(top, window.innerHeight - box.height - 16)) - top,
      };
      element.style.transform = `translate(${next.x}px, ${next.y}px)`;
      offset.current = next;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    window.addEventListener('resize', place);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); };
  }, [x, y, width, height, viewport.x, viewport.y, viewport.zoom]);

  return <NodeToolbar nodeId={nodeId} isVisible position={Position.Bottom} offset={16}
    className="nodrag nopan nowheel pointer-events-auto">
    <div ref={panel} onMouseDown={event => event.stopPropagation()}>{children}</div>
  </NodeToolbar>;
}
