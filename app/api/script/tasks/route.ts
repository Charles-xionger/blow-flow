import { getScriptService, ScriptError } from '@/lib/script/service';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try { return Response.json(getScriptService().create(await request.json()), { status: 201 }); }
  catch (error) { return Response.json({ error: error instanceof ScriptError ? error.message : '脚本任务服务不可用' }, { status: error instanceof ScriptError ? error.status : 500 }); }
}
export function GET(request: Request) {
  const url = new URL(request.url);
  const canvasId = url.searchParams.get('canvasId');
  if (!canvasId) return Response.json({ error: '缺少画布身份' }, { status: 400 });
  return Response.json(getScriptService().list(canvasId, url.searchParams.get('nodeId') || undefined), { headers: { 'Cache-Control': 'no-store' } });
}
