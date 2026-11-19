import { handleCanvasSave } from "@/lib/canvas/save-route";
import { NextRequest, NextResponse } from "next/server";
import {
  getWorkflowById,
  deleteWorkflow,
  isWorkflowDeleted,
} from "@/lib/db/workflows";
import { goAuthorized, goCutoverEnabled, goMapped } from '@/lib/go-cutover';
import { readGoWorkflow, saveGoWorkflow } from '@/lib/go-workflow';

// GET: 获取单个工作流
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if(goCutoverEnabled())return readGoWorkflow(request,id);
    const workflow = getWorkflowById(id);

    if (!workflow) {
      const deleted = isWorkflowDeleted(id);
      return NextResponse.json(
        { success: false, error: deleted ? "画布已被删除，本地内容已保留，请另存副本" : "Workflow not found" },
        { status: deleted ? 410 : 404 },
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

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if(goCutoverEnabled())return saveGoWorkflow(request,(await params).id);
  return handleCanvasSave(request, (await params).id);
}

// DELETE: 删除工作流
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if(goCutoverEnabled()){
      const current=await goAuthorized(request,`/v1/projects/${encodeURIComponent(id)}`);
      if(!current.response?.ok)return NextResponse.json({success:false,error:'项目不存在或请先登录'},{status:current.response?.status??401});
      const project=await current.response.json() as {version:number};
      return goMapped(request,`/v1/projects/${encodeURIComponent(id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'trash',expectedVersion:project.version})},()=>({}));
    }
    const success = deleteWorkflow(id);

    if (!success) {
      const deleted = isWorkflowDeleted(id);
      return NextResponse.json(
        { success: false, error: deleted ? "画布已被删除，本地内容已保留，请另存副本" : "Workflow not found" },
        { status: deleted ? 410 : 404 },
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
