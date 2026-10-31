"use client";

import { createContext, memo, useContext, type ReactNode } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { NodeType, type NodeData } from "@/types";
import { EditableTitle } from "./shared/EditableTitle";
import { QuickAddNode } from "../canvas/QuickAddNode";
import { nodeDefinitions } from "@/lib/canvas/node-definitions";
import { cn } from "@/lib/utils";

const SurfaceContext = createContext({ dragging: false, selected: false, loading: false, error: false, height: 240 });

/** Business chrome only. xyflow owns positioning, dragging, selection and handles. */
export const BaseNode = memo(function BaseNode({ children, ...props }: NodeProps<Node<NodeData>> & { children: ReactNode }) {
  const { id, data, selected, dragging, isConnectable } = props;
  const definition = nodeDefinitions[data.type];
  return (
    <SurfaceContext.Provider value={{ dragging, selected, loading: !!data.isLoading, error: !!data.error, height: definition.height }}>
      <div className={cn("relative w-80", dragging && "[&_.node-panel]:invisible [&_.node-panel]:pointer-events-none")}>
        <EditableTitle nodeId={id} defaultTitle={data.type === NodeType.TEXT ? "文本描述" : data.label} customTitle={data.customTitle} />
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
export function NodeSurface({ children }: { children: ReactNode }) {
  const { dragging, selected, loading, error, height } = useContext(SurfaceContext);
  return (
    <div style={{ width: 320, height }} className={cn(
      "relative rounded-2xl border bg-[#1a1a1a] overflow-hidden shadow-xl group",
      selected ? "border-purple-500 ring-2 ring-purple-500/30" : "border-zinc-700/50",
      loading && "border-blue-500", error && "border-red-500",
    )}>
      <div className="h-full w-full" style={{ contentVisibility: dragging ? "hidden" : "visible" }}>{children}</div>
      {dragging && <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-400">移动中…</div>}
    </div>
  );
}
