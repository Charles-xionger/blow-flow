import { Suspense } from "react";
import Canvas from "@/components/canvas/Canvas";
import { ThemeInitializer } from "@/components/ThemeInitializer";
import { CanvasOpeningState } from "@/components/canvas/CanvasOpeningState";

export default function CanvasPage() {
  return <><ThemeInitializer /><div className="h-screen"><Suspense fallback={<CanvasOpeningState />}><Canvas /></Suspense></div></>;
}
