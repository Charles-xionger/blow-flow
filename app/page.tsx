import { Suspense } from "react";
import Canvas from "@/components/canvas/Canvas";
import { ThemeInitializer } from "@/components/ThemeInitializer";

export default function Home() {
  return (
    <>
      <ThemeInitializer />
      <div className="flex h-screen">
        <div className="flex-1">
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-full bg-zinc-950 text-white">
                Loading...
              </div>
            }
          >
            <Canvas />
          </Suspense>
        </div>
      </div>
    </>
  );
}
