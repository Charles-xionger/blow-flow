'use client';

import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { Unplug } from 'lucide-react';
import { useCanvasStore } from '@/store/useCanvasStore';

/** A selected connection exposes the same undoable deletion as the keyboard. */
export function CanvasEdge(props: EdgeProps) {
  const deleteElements = useCanvasStore(state => state.deleteElements);
  const [path, x, y] = getBezierPath(props);
  return <>
    <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} markerStart={props.markerStart}
      interactionWidth={24} style={{ ...props.style, ...(props.selected ? { stroke: '#8b5cf6', strokeWidth: 3 } : {}) }}/>
    {props.selected && <EdgeLabelRenderer>
      <button type="button" aria-label="断开连线" title="断开连线（Delete / Backspace）"
        className="nodrag nopan pointer-events-auto absolute flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground shadow-md hover:bg-muted"
        style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
        onClick={event => { event.stopPropagation(); deleteElements([], [props.id]); }}>
        <Unplug size={14}/>断开连线
      </button>
    </EdgeLabelRenderer>}
  </>;
}
