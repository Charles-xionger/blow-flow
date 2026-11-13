import { Suspense } from "react";
import Canvas from "@/components/canvas/Canvas";
import { ThemeInitializer } from "@/components/ThemeInitializer";

export default function CanvasPage() {
  return <><ThemeInitializer /><div className="h-screen"><Suspense fallback={<div className="flex h-full items-center justify-center">正在加载画布…</div>}><Canvas /></Suspense></div></>;
}
