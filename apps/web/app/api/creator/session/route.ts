import { NextRequest, NextResponse } from 'next/server';
import { clearCreatorCookies, creatorRefresh, goCutoverEnabled, goJSON, goPublic, sameOriginRequest, setCreatorCookies, upstreamRefresh } from '@/lib/go-cutover';

export async function GET(request: NextRequest) {
  if (!goCutoverEnabled()) return NextResponse.json({ error: '未启用 Go 用户登录' }, { status: 404 });
  return goJSON(request, '/v1/me');
}
export async function POST(request: NextRequest) {
  if (!goCutoverEnabled()) return NextResponse.json({ error: '未启用 Go 用户登录' }, { status: 404 });
  if (!sameOriginRequest(request)) return NextResponse.json({ error: '请求来源无效' }, { status: 403 });
  try {
    const body = await request.json();
    const upstream = await goPublic('/v1/auth/user/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await upstream.json();
    if (!upstream.ok) return NextResponse.json(result, { status: upstream.status });
    const out = NextResponse.json({ user: result.user }, { headers: { 'Cache-Control': 'no-store' } });
    setCreatorCookies(out, result.accessToken, upstreamRefresh(upstream));
    return out;
  } catch { return NextResponse.json({ error: '登录暂不可用' }, { status: 503 }); }
}
export async function DELETE(request: NextRequest) {
  if (!goCutoverEnabled()) return NextResponse.json({ error: '未启用 Go 用户登录' }, { status: 404 });
  if (!sameOriginRequest(request)) return NextResponse.json({ error: '请求来源无效' }, { status: 403 });
  const refresh = creatorRefresh(request);
  if (refresh) await goPublic('/v1/auth/user/logout', { method: 'POST', headers: { Cookie: `blow_flow_user_refresh=${refresh}`, 'Sec-Fetch-Site': 'same-origin' } }).catch(() => undefined);
  const out = new NextResponse(null, { status: 204 }); clearCreatorCookies(out); return out;
}
