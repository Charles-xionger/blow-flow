import Canvas from "@/components/canvas/Canvas";
import { ThemeInitializer } from "@/components/ThemeInitializer";

export default function Home() {
  return (
    <>
      <ThemeInitializer />
      <div className="flex h-screen">
        <div className="flex-1">
          <Canvas />
        </div>
      </div>
    </>
  );
}
