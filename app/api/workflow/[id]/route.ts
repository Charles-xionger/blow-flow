import { NextRequest, NextResponse } from "next/server";
import {
  getWorkflowById,
  updateWorkflow,
  deleteWorkflow,
} from "@/lib/db/workflows";

// GET: 获取单个工作流
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const workflow = getWorkflowById(params.id);

    if (!workflow) {
      return NextResponse.json(
        { success: false, error: "Workflow not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true, data: workflow });
  } catch (error) {
    console.error("[API] Get workflow error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to get workflow",
      },
      { status: 500 },
    );
  }
}

// PUT: 更新工作流
export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const body = await request.json();
    const success = updateWorkflow(params.id, body);

    if (!success) {
      return NextResponse.json(
        { success: false, error: "Workflow not found" },
        { status: 404 },
      );
    }

    const workflow = getWorkflowById(params.id);
    return NextResponse.json({ success: true, data: workflow });
  } catch (error) {
    console.error("[API] Update workflow error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to update workflow",
      },
      { status: 500 },
    );
  }
}

// DELETE: 删除工作流
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const success = deleteWorkflow(params.id);

    if (!success) {
      return NextResponse.json(
        { success: false, error: "Workflow not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[API] Delete workflow error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to delete workflow",
      },
      { status: 500 },
    );
  }
}
