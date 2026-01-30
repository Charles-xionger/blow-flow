import { NextRequest, NextResponse } from "next/server";
import { getAllWorkflows, createWorkflow } from "@/lib/db/workflows";

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

// POST: 创建新工作流
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, nodes, edges, viewport } = body;

    if (!name) {
      return NextResponse.json(
        { success: false, error: "Workflow name is required" },
        { status: 400 },
      );
    }

    const workflow = createWorkflow({ name, nodes, edges, viewport });

    return NextResponse.json({ success: true, data: workflow });
  } catch (error) {
    console.error("[API] Create workflow error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to create workflow",
      },
      { status: 500 },
    );
  }
}
