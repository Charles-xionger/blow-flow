import { NextRequest, NextResponse } from 'next/server';
import { goMapped } from './go-cutover';
import { validateSaveOperation, type SaveOperation } from './canvas/save-protocol';
import { migrateScriptSnapshot } from './canvas/script-migration';
import type { WorkflowData } from './db/workflows';

type GoProject = { id:string; name:string; snapshot:Pick<WorkflowData,'name'|'nodes'|'edges'|'viewport'|'history'>; version:number; createdAt:string; updatedAt:string };

export function workflowFromGo(project:GoProject):WorkflowData {
  return { ...migrateScriptSnapshot(project.snapshot), id:project.id, name:project.name, version:project.version,
    createdAt:Date.parse(project.createdAt), updatedAt:Date.parse(project.updatedAt) };
}

export function readGoWorkflow(request:NextRequest,id:string) {
  return goMapped<GoProject>(request,`/v1/projects/${encodeURIComponent(id)}`,{},workflowFromGo);
}

export async function saveGoWorkflow(request:NextRequest,pathId?:string) {
  let operation:SaveOperation;
  try { const body:unknown=await request.json(); validateSaveOperation(body); operation=body;
    if(pathId && pathId!==operation.id) return NextResponse.json({success:false,error:'画布 ID 不匹配'},{status:400});
  } catch(error) {return NextResponse.json({success:false,error:error instanceof Error?error.message:'请求无效'},{status:400});}
  return goMapped(request,`/v1/projects/${encodeURIComponent(operation.id)}/canvas`,{
    method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:operation.requestId,baseVersion:operation.baseVersion,snapshot:operation.snapshot})
  },value=>value);
}

export async function readGoWorkflows(request:NextRequest) {
  return goMapped<{projects:Array<{id:string;name:string;nodeCount:number;updatedAt:string}>}>(request,'/v1/workspace',{},workspace=>
    workspace.projects.map(project=>({...project,updatedAt:Date.parse(project.updatedAt)})));
}
