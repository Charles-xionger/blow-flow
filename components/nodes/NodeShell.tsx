"use client";

import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import type { NodeData } from "@/types";
import { useCanvasStore } from "@/store/useCanvasStore";
import { BaseNode, NodeSurface } from "./BaseNode";

/**
 * Three-layer node: toolbar, stage, console. A node type declares what goes in each slot;
 * the shell decides when they show. Toolbar and console are absolutely positioned, so they
 * never affect the measured node, its handles or its edges.
 */
export function NodeShell({ toolbar, console: nodeConsole, stageTestId, children, ...props }: NodeProps<Node<NodeData>> & {
  toolbar?: ReactNode;
  console?: ReactNode;
  stageTestId?: string;
  children: ReactNode;
}) {
  // Only the selected node subscribes: otherwise every node re-renders when selection starts.
  const singleSelected = useCanvasStore((state) => !!props.selected && state.selectedNodeIds.length === 1);
  const open = useOpenAfterClick(singleSelected, props.dragging);
  return (
    <BaseNode {...props} onPointerDownCapture={open.press}>
      <NodeSurface testId={stageTestId}>{children}</NodeSurface>
      {/* Hidden, not unmounted, while dragging: remounting the console is the expensive part. */}
      {open.mounted && <div hidden={props.dragging}>
        {toolbar && (
          <div role="toolbar" aria-label="节点工具栏"
            className="nokey nodrag nopan absolute bottom-full left-1/2 z-70 mb-8 flex -translate-x-1/2 items-center gap-0.5 rounded-xl border border-white/10 bg-[#222] p-1 shadow-xl">
            {toolbar}
          </div>
        )}
        {nodeConsole}
      </div>}
    </BaseNode>
  );
}

/**
 * Mount toolbar and console once a press on the stage is released. Pressing an unselected
 * node selects it immediately; mounting then would be thrown away by the drag that follows.
 * A drag that starts before they are mounted keeps them closed until the next press.
 */
function useOpenAfterClick(eligible: boolean, dragging: boolean | undefined) {
  const [pressing, setPressing] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [dragged, setDragged] = useState(false);
  if (!eligible && (mounted || dragged)) { setMounted(false); setDragged(false); }
  if (eligible && dragging && !mounted && !dragged) setDragged(true);
  if (eligible && !pressing && !dragging && !dragged && !mounted) setMounted(true);
  useEffect(() => {
    if (!pressing) return;
    const release = () => setPressing(false);
    window.addEventListener("pointerup", release, { once: true });
    window.addEventListener("pointercancel", release, { once: true });
    return () => { window.removeEventListener("pointerup", release); window.removeEventListener("pointercancel", release); };
  }, [pressing]);
  // Each press starts fresh: a later click on the node that was dragged still opens them.
  return { mounted, press: () => { if (!mounted) { setPressing(true); setDragged(false); } } };
}

export function NodeToolbarButton({ label, icon: Icon, disabled, onClick }: {
  label: string;
  icon: ComponentType<{ size?: number }>;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-300 hover:bg-white/10 disabled:pointer-events-none disabled:opacity-30">
      <Icon size={15} />
    </button>
  );
}
