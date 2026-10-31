"use client";

import { useEffect } from "react";
import { canvasDraftStorage } from "@/store/useCanvasStore";

// Stable callbacks; xyflow still owns every pointer event and position calculation.
const interactionHandlers = {
  onMoveStart: () => canvasDraftStorage.beginInteraction("viewport"),
  onMoveEnd: () => canvasDraftStorage.endInteraction("viewport"),
  onNodeDragStart: () => canvasDraftStorage.beginInteraction("drag"),
  onNodeDragStop: () => canvasDraftStorage.endInteraction("drag"),
  onSelectionDragStart: () => canvasDraftStorage.beginInteraction("selection"),
  onSelectionDragStop: () => canvasDraftStorage.endInteraction("selection"),
};

export function useCanvasInteractions() {
  useEffect(() => {
    const flush = () => canvasDraftStorage.flush();
    const onVisibility = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      for (const key of ["viewport", "drag", "selection"]) canvasDraftStorage.endInteraction(key);
      flush();
    };
  }, []);
  return interactionHandlers;
}
