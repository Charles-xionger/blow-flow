import { NextRequest, NextResponse } from 'next/server';
import { getWorkflowHistory, isWorkflowDeleted } from '@/lib/db/workflows';
import { historyPage } from '@/lib/canvas/history-page';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const query = request.nextUrl.searchParams;
  const page = Number(query.get('page') ?? 0);
  if (!Number.isSafeInteger(page) || page < 0 || page > 1_000_000) return NextResponse.json({ error: '页码无效' }, { status: 400 });
  const { id } = await params;
  const project = getWorkflowHistory(id);
  if (!project) return NextResponse.json({ error: '项目不存在或已被删除' }, { status: isWorkflowDeleted(id) ? 410 : 404 });
  if (query.has('version') && Number(query.get('version')) !== project.version) {
    return NextResponse.json({ error: '历史已更新，请重新加载后查看' }, { status: 409 });
  }
  const result = historyPage(project.history, page, query.get('batch') ?? undefined, query.get('operation') ?? undefined);
  if (!result) return NextResponse.json({ error: '历史记录不存在' }, { status: 404 });
  return NextResponse.json({ ...result, name: project.name, version: project.version }, { headers: { 'Cache-Control': 'no-store' } });
}
