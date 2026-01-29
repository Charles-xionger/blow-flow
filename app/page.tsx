import Canvas from "@/components/canvas/Canvas";
import Sidebar from "@/components/sidebar/Sidebar";

export default function Home() {
  return (
    <div className="flex h-screen">
      <Sidebar />
      <div className="flex-1">
        <Canvas />
      </div>
    </div>
  );
}
