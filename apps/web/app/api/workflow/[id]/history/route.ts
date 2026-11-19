import { NextRequest, NextResponse } from 'next/server';
import { getWorkflowHistory, isWorkflowDeleted } from '@/lib/db/workflows';
import { historyPage } from '@/lib/canvas/history-page';
import { goAuthorized, goCutoverEnabled, setCreatorCookies } from '@/lib/go-cutover';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const query = request.nextUrl.searchParams;
  const page = Number(query.get('page') ?? 0);
  if (!Number.isSafeInteger(page) || page < 0 || page > 1_000_000) return NextResponse.json({ error: '页码无效' }, { status: 400 });
  const { id } = await params;
  if(goCutoverEnabled()){
    const {response,refreshed}=await goAuthorized(request,`/v1/projects/${encodeURIComponent(id)}`).catch(()=>({response:undefined,refreshed:undefined}));
    if(!response?.ok)return NextResponse.json({error:'项目不存在或请先登录'},{status:response?.status??503});
    const project=await response.json() as {name:string;version:number;snapshot:{history?:import('@/lib/canvas/history-view').HistorySource}};
    if(query.has('version') && Number(query.get('version'))!==project.version)return NextResponse.json({error:'历史已更新，请重新加载后查看'},{status:409});
    const result=historyPage(project.snapshot?.history,page,query.get('batch')??undefined,query.get('operation')??undefined);
    if(!result)return NextResponse.json({error:'历史记录不存在'},{status:404});
    const out=NextResponse.json({...result,name:project.name,version:project.version},{headers:{'Cache-Control':'no-store'}});
    if(refreshed)setCreatorCookies(out,refreshed.access,refreshed.refresh);
    return out;
  }
  const project = getWorkflowHistory(id);
  if (!project) return NextResponse.json({ error: '项目不存在或已被删除' }, { status: isWorkflowDeleted(id) ? 410 : 404 });
  if (query.has('version') && Number(query.get('version')) !== project.version) {
    return NextResponse.json({ error: '历史已更新，请重新加载后查看' }, { status: 409 });
  }
  const result = historyPage(project.history, page, query.get('batch') ?? undefined, query.get('operation') ?? undefined);
  if (!result) return NextResponse.json({ error: '历史记录不存在' }, { status: 404 });
  return NextResponse.json({ ...result, name: project.name, version: project.version }, { headers: { 'Cache-Control': 'no-store' } });
}
