"use client";

import type { ComponentType, ReactNode } from "react";
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
  const singleSelected = useCanvasStore((state) => state.selectedNodeIds.length === 1);
  const open = props.selected && singleSelected && !props.dragging;
  return (
    <BaseNode {...props}>
      <NodeSurface testId={stageTestId}>{children}</NodeSurface>
      {open && toolbar && (
        <div role="toolbar" aria-label="节点工具栏"
          className="nodrag nopan absolute bottom-full left-1/2 z-70 mb-8 flex -translate-x-1/2 items-center gap-0.5 rounded-xl border border-white/10 bg-[#222] p-1 shadow-xl">
          {toolbar}
        </div>
      )}
      {open && nodeConsole}
    </BaseNode>
  );
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
