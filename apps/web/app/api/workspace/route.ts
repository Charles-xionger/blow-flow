import { NextRequest, NextResponse } from "next/server";
import { getWorkspace, manageWorkspace } from "@/lib/db/workspace";
import { CanvasSaveError } from "@/lib/canvas/save-protocol";

export const runtime = "nodejs";

export function GET(request: NextRequest) {
  try {
    return NextResponse.json({ success: true, data: getWorkspace(request.nextUrl.searchParams.get("trash") === "true") },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[Workspace] List failed", error);
    return NextResponse.json({ success: false, error: "项目加载失败，请重试" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const command = await request.json();
    return NextResponse.json({ success: true, data: manageWorkspace(command) });
  } catch (error) {
    const status = error instanceof CanvasSaveError ? error.status : error instanceof SyntaxError ? 400 : 500;
    if (status === 500) console.error("[Workspace] Update failed", error);
    return NextResponse.json({ success: false, error: error instanceof CanvasSaveError ? error.message : "操作失败，请重试" }, { status });
  }
}
