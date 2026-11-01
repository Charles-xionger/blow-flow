import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useCanvasStore } from "@/store/useCanvasStore";
import { describeUpstream } from "@/lib/canvas/prompt";
import { useNodeInputs } from "./useNodeInputs";

/** Stays stable while upstream nodes only move, so open consoles don't re-render during drags. */
export function useUpstreamNodes(nodeId: string) {
  const ids = useCanvasStore(useShallow((state) => state.edges
    .filter((edge) => edge.target === nodeId).map((edge) => edge.source)));
  const inputs = useNodeInputs(nodeId);
  return useMemo(() => describeUpstream(ids.flatMap((id, index) => {
    const data = inputs[index];
    return data ? [{ id, data }] : [];
  })), [ids, inputs]);
}
