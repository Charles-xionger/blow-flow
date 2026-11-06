import { getScriptVersionService } from '@/lib/script/versions';
import { ScriptError } from '@/lib/script/service';
export const runtime = 'nodejs';
const failure = (error: unknown) => Response.json({ error:error instanceof ScriptError ? error.message : '脚本版本服务不可用' },{ status:error instanceof ScriptError ? error.status : 500 });
export function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const canvasId = params.get('canvasId'); const nodeId = params.get('nodeId');
    if (!canvasId || !nodeId) throw new ScriptError('缺少脚本节点身份');
    return Response.json(getScriptVersionService().list(canvasId,nodeId),{ headers:{'Cache-Control':'no-store'} });
  } catch (error) { return failure(error); }
}
export async function PATCH(request: Request) {
  try {
    const value = await request.json(); const service = getScriptVersionService();
    if (typeof value.versionId !== 'string') throw new ScriptError('缺少版本身份');
    if (value.action === 'draft') return Response.json(service.saveDraft(value.versionId,value.text,value.expectedRevision));
    if (value.action === 'select' && typeof value.canvasId === 'string' && typeof value.nodeId === 'string') return Response.json(service.select(value.canvasId,value.nodeId,value.versionId,value.expectedRevision));
    throw new ScriptError('无效的版本操作');
  } catch (error) { return failure(error); }
}
