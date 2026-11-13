import { handleCanvasSave } from "@/lib/canvas/save-route";
import { NextRequest, NextResponse } from "next/server";
import { getAllWorkflows } from "@/lib/db/workflows";

// GET: 获取所有工作流
export async function GET() {
  try {
    const workflows = getAllWorkflows();
    return NextResponse.json({ success: true, data: workflows });
  } catch (error) {
    console.error("[API] Get workflows error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to get workflows",
      },
      { status: 500 },
    );
  }
}

// POST and PUT use the same versioned protocol.
export async function POST(request: NextRequest) {
  return handleCanvasSave(request);
}
