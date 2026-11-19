import { NextResponse } from 'next/server';
import { goCutoverEnabled, goPublic } from '@/lib/go-cutover';

export async function GET() {
  if (!goCutoverEnabled()) return NextResponse.json({ error: '未启用 Go 用户登录' }, { status: 404 });
  try {
    const upstream = await goPublic('/v1/auth/captcha');
    return NextResponse.json(await upstream.json(), { status: upstream.status, headers: { 'Cache-Control': 'no-store' } });
  } catch { return NextResponse.json({ error: '验证码暂不可用' }, { status: 503 }); }
}
