import { getScriptService, ScriptError } from '@/lib/script/service';
export const runtime = 'nodejs';
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try { return Response.json(getScriptService().stop((await context.params).id)); }
  catch (error) { return Response.json({ error: error instanceof ScriptError ? error.message : '脚本任务服务不可用' }, { status: error instanceof ScriptError ? error.status : 500 }); }
}
