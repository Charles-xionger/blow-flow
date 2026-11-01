"use client";

import { createContext, memo, useContext, type ReactNode } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { NodeData } from "@/types";
import { nodeName } from "@/lib/canvas/prompt";
import { EditableTitle } from "./shared/EditableTitle";
import { QuickAddNode } from "../canvas/QuickAddNode";
import { nodeDefinitions } from "@/lib/canvas/node-definitions";
import { cn } from "@/lib/utils";

const SurfaceContext = createContext({ dragging: false, selected: false, loading: false, error: false, width: 320, height: 240 });

/** Business chrome only. xyflow owns positioning, dragging, selection and handles. */
export const BaseNode = memo(function BaseNode({ children, ...props }: NodeProps<Node<NodeData>> & {
  children: ReactNode;
}) {
  const { id, data, selected, dragging, isConnectable } = props;
  const definition = nodeDefinitions[data.type];
  return (
    <SurfaceContext.Provider value={{ dragging, selected, loading: !!data.isLoading, error: !!data.error, width: 320, height: definition.height }}>
      <div style={{ width: 320 }} className={cn("relative", dragging && "[&_.node-panel]:invisible [&_.node-panel]:pointer-events-none")}>
        <EditableTitle nodeId={id} defaultTitle={nodeName({ ...data, customTitle: undefined })} customTitle={data.customTitle} />
        {definition.input && <Handle type="target" position={Position.Left} id="input" isConnectable={isConnectable} />}
        <div className="absolute right-0 top-1/2 -translate-y-1/2 flex items-center">
          {!dragging && <QuickAddNode nodeId={id} />}
          <Handle type="source" position={Position.Right} id="output" isConnectable={isConnectable} />
        </div>
        {children}
      </div>
    </SurfaceContext.Provider>
  );
});

/** Keep dimensions and mounted form state stable while suppressing expensive painting. */
export function NodeSurface({ children, testId }: { children: ReactNode; testId?: string }) {
  const { dragging, selected, loading, error, width, height } = useContext(SurfaceContext);
  return (
    <div data-testid={testId} style={{ width, height }} className={cn(
      "relative rounded-2xl border bg-[#1a1a1a] overflow-hidden shadow-xl group",
      selected ? "border-purple-500 ring-2 ring-purple-500/30" : "border-zinc-700/50",
      loading && "border-blue-500", error && "border-red-500",
    )}>
      <div className="h-full w-full" style={{ contentVisibility: dragging ? "hidden" : "visible" }}>{children}</div>
      {dragging && <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-400">移动中…</div>}
    </div>
  );
}
