import { NextRequest, NextResponse } from 'next/server';

export const goCutoverEnabled = () => process.env.GO_CUTOVER === '1';
const accessCookie = 'blow_flow_creator_access';
const refreshCookie = 'blow_flow_creator_refresh';
const upstreamRefreshCookie = 'blow_flow_user_refresh';
const apiBase = () => {
  const value = process.env.GO_API_URL;
  if (!value) throw new Error('GO_API_URL is required for Go cutover');
  return value.replace(/\/$/, '');
};
const secure = () => process.env.APP_ENV === 'production' || process.env.NODE_ENV === 'production';
const tokenFrom = (response: Response) => response.headers.get('set-cookie')?.match(/(?:^|,\s*)blow_flow_user_refresh=([^;]+)/)?.[1];

export function setCreatorCookies(response: NextResponse, access: string, refresh?: string) {
  response.cookies.set(accessCookie, access, { httpOnly: true, secure: secure(), sameSite: 'strict', path: '/', maxAge: 900 });
  if (refresh) response.cookies.set(refreshCookie, refresh, { httpOnly: true, secure: secure(), sameSite: 'strict', path: '/', maxAge: 7 * 24 * 3600 });
}
export function clearCreatorCookies(response: NextResponse) {
  for (const name of [accessCookie, refreshCookie]) response.cookies.set(name, '', { httpOnly: true, secure: secure(), sameSite: 'strict', path: '/', maxAge: 0 });
}
export function creatorRefresh(request: NextRequest) { return request.cookies.get(refreshCookie)?.value; }
export function creatorAccess(request: NextRequest) { return request.cookies.get(accessCookie)?.value; }
export function sameOriginRequest(request:NextRequest) {
  const origin=request.headers.get('origin');
  const site=request.headers.get('sec-fetch-site');
  let validOrigin=true;
  if(origin){
    try {
      const parsed=new URL(origin);
      validOrigin=parsed.host===(request.headers.get('host')??request.nextUrl.host) && parsed.protocol===request.nextUrl.protocol;
    } catch { validOrigin=false; }
  }
  return validOrigin && (!site || site==='same-origin' || site==='none');
}
export function upstreamRefresh(response: Response) { return tokenFrom(response); }
export async function goPublic(path: string, init: RequestInit = {}) {
  return fetch(`${apiBase()}${path}`, { ...init, cache: 'no-store', signal: init.signal ?? AbortSignal.timeout(15_000) });
}

export async function goAuthorized(request: NextRequest, path: string, init: RequestInit = {}) {
  let access = creatorAccess(request);
  let refreshed: { access: string; refresh?: string } | undefined;
  const call = (token: string) => goPublic(path, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
  let response = access ? await call(access) : undefined;
  if (!response || response.status === 401) {
    const refresh = creatorRefresh(request);
    if (refresh) {
      const renewed = await goPublic('/v1/auth/user/refresh', { method: 'POST', headers: { Cookie: `${upstreamRefreshCookie}=${refresh}`, 'Sec-Fetch-Site': 'same-origin' } });
      if (renewed.ok) {
        const body = await renewed.json() as { accessToken: string };
        access = body.accessToken;
        refreshed = { access, refresh: upstreamRefresh(renewed) };
        response = await call(access);
      }
    }
  }
  return { response, refreshed };
}
export async function goJSON(request: NextRequest, path: string, init: RequestInit = {}) {
  try {
    const { response, refreshed } = await goAuthorized(request, path, init);
    if (!response) return NextResponse.json({ error: '请先登录' }, { status: 401 });
    const body = response.status === 204 ? null : await response.json().catch(() => null);
    const out = body === null ? new NextResponse(null, { status: response.status }) : NextResponse.json(body, { status: response.status });
    out.headers.set('Cache-Control', 'no-store');
    if (refreshed) setCreatorCookies(out, refreshed.access, refreshed.refresh);
    return out;
  } catch {
    return NextResponse.json({ error: 'Go API 暂不可用' }, { status: 503 });
  }
}
export async function goMapped<T>(request: NextRequest, path: string, init: RequestInit, map: (value: T) => unknown, wrap = true) {
  if(init.method && !['GET','HEAD'].includes(init.method.toUpperCase()) && !sameOriginRequest(request))
    return NextResponse.json({success:false,error:'请求来源无效'},{status:403});
  try {
    const { response, refreshed } = await goAuthorized(request, path, init);
    if (!response) return NextResponse.json({ success: false, error: '请先登录' }, { status: 401 });
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    const body = response.ok ? wrap ? { success: true, data: map(data as T) } : map(data as T) : { success: false, error: typeof data?.error === 'string' ? data.error : '请求失败' };
    const out = NextResponse.json(body, { status: response.status === 204 ? 200 : response.status, headers: { 'Cache-Control': 'no-store' } });
    if (refreshed) setCreatorCookies(out, refreshed.access, refreshed.refresh);
    return out;
  } catch { return NextResponse.json({ success: false, error: 'Go API 暂不可用' }, { status: 503 }); }
}
