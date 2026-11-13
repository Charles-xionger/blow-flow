import { useShallow } from "zustand/react/shallow";
import { useCanvasStore } from "@/store/useCanvasStore";

/** Preserve input references when upstream nodes only move or change selection. */
export function useNodeInputs(nodeId: string) {
  return useCanvasStore(useShallow((state) => state.edges
    .filter((edge) => edge.target === nodeId)
    .map((edge) => state.nodes.find((node) => node.id === edge.source)?.data)));
}
