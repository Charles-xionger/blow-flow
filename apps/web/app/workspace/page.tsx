import { Suspense } from "react";
import Workspace from "@/components/workspace/Workspace";

export default function WorkspacePage() {
  return <Suspense fallback={<div className="min-h-screen bg-[#101112] text-zinc-400 p-12" role="status">正在加载工作空间…</div>}><Workspace /></Suspense>;
}
