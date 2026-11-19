import { NextRequest, NextResponse } from "next/server";
import { getWorkspace, manageWorkspace } from "@/lib/db/workspace";
import { CanvasSaveError } from "@/lib/canvas/save-protocol";
import { goAuthorized, goCutoverEnabled, goMapped, sameOriginRequest, setCreatorCookies } from '@/lib/go-cutover';
import type { WorkspaceCommand, WorkspaceData } from '@/lib/workspace/types';

export const runtime = "nodejs";

export function GET(request: NextRequest) {
  if (goCutoverEnabled()) return goMapped<{projects:Array<{id:string;name:string;folderId:string|null;coverUrl?:string|null;nodeCount:number;version:number;createdAt:string;updatedAt:string;deletedAt?:string|null}>;folders:Array<{id:string;name:string;projectCount:number;createdAt:string;updatedAt:string}>}>(request,`/v1/workspace${request.nextUrl.searchParams.get('trash')==='true'?'?trash=true':''}`,{},value=>({projects:value.projects.map(project=>({...project,coverUrl:project.coverUrl??null,deletedAt:project.deletedAt?Date.parse(project.deletedAt):null,createdAt:Date.parse(project.createdAt),updatedAt:Date.parse(project.updatedAt)})),folders:value.folders.map(folder=>({...folder,createdAt:Date.parse(folder.createdAt),updatedAt:Date.parse(folder.updatedAt)}))} satisfies WorkspaceData));
  try {
    return NextResponse.json({ success: true, data: getWorkspace(request.nextUrl.searchParams.get("trash") === "true") },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[Workspace] List failed", error);
    return NextResponse.json({ success: false, error: "项目加载失败，请重试" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if(goCutoverEnabled()){
    if(!sameOriginRequest(request))return NextResponse.json({success:false,error:'请求来源无效'},{status:403});
    let command:WorkspaceCommand;
    try{command=await request.json();}catch{return NextResponse.json({success:false,error:'无效操作'},{status:400});}
    const json=(value:unknown)=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
    switch(command.action){
      case 'create-project': {
        try {
          const {response,refreshed}=await goAuthorized(request,'/v1/projects',json({id:command.id,name:'未命名项目',folderId:command.folderId}));
          if(!response)return NextResponse.json({success:false,error:'请先登录'},{status:401});
          let accepted=response.ok;
          if(response.status===409){const existing=await goAuthorized(request,`/v1/projects/${encodeURIComponent(command.id)}`);accepted=!!existing.response?.ok;}
          const out=NextResponse.json(accepted?{success:true,data:{id:command.id}}:{success:false,error:'创建项目失败'},{status:accepted?200:response.status});
          if(refreshed)setCreatorCookies(out,refreshed.access,refreshed.refresh);
          return out;
        }catch{return NextResponse.json({success:false,error:'Go API 暂不可用'},{status:503});}
      }
      case 'create-folder':return goMapped(request,'/v1/folders',json({id:command.id,name:command.name}),()=>({id:command.id}));
      case 'rename-folder':return goMapped(request,`/v1/folders/${encodeURIComponent(command.id)}`,{...json({name:command.name}),method:'PATCH'},()=>({}));
      case 'delete-folder':return goMapped(request,`/v1/folders/${encodeURIComponent(command.id)}`,{method:'DELETE'},()=>({}));
      case 'rename-project':case 'move':case 'trash':case 'restore':case 'purge':{
        if(command.targets.length!==1)return NextResponse.json({success:false,error:'Go 切流模式暂时只支持逐个操作项目'},{status:400});
        const target=command.targets[0];
        return goMapped(request,`/v1/projects/${encodeURIComponent(target.id)}`,{...json({action:command.action==='rename-project'?'rename':command.action,expectedVersion:target.version,...(command.action==='rename-project'?{name:command.name}:{}),...(command.action==='move'?{folderId:command.folderId}:{})}),method:'PATCH'},()=>({}));
      }
      default:return NextResponse.json({success:false,error:'不支持的操作'},{status:400});
    }
  }
  try {
    const command = await request.json();
    return NextResponse.json({ success: true, data: manageWorkspace(command) });
  } catch (error) {
    const status = error instanceof CanvasSaveError ? error.status : error instanceof SyntaxError ? 400 : 500;
    if (status === 500) console.error("[Workspace] Update failed", error);
    return NextResponse.json({ success: false, error: error instanceof CanvasSaveError ? error.message : "操作失败，请重试" }, { status });
  }
}
