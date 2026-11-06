import { ScriptPublishingService, ScriptPublishConflict } from '@/lib/script/publishing';
import { ScriptError } from '@/lib/script/service';
export const runtime = 'nodejs';
const failure = (error: unknown) => Response.json({error:error instanceof ScriptError ? error.message : '发布服务不可用',...(error instanceof ScriptPublishConflict ? {target:error.target} : {})},{status:error instanceof ScriptError ? error.status : 500});
export function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const canvasId = params.get('canvasId'), nodeId = params.get('nodeId');
    if (!canvasId || !nodeId) throw new ScriptError('缺少脚本节点身份');
    return Response.json({target:new ScriptPublishingService().target(canvasId,nodeId)},{headers:{'Cache-Control':'no-store'}});
  } catch(error) { return failure(error); }
}
export async function POST(request: Request) {
  try { return Response.json(new ScriptPublishingService().publish(await request.json())); }
  catch(error) { return failure(error); }
}
