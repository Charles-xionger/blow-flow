'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import { Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { BrandMark } from '@/components/ui/brand-mark';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

type Captcha = { id: string; image: string };

export function CreatorLoginGate() {
  const [state, setState] = useState<'checking' | 'login' | 'ready'>('checking');
  const [captcha, setCaptcha] = useState<Captcha>();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function reloadCaptcha() {
    try {
      const response = await fetch('/api/creator/captcha', { cache: 'no-store' });
      if (!response.ok) throw new Error('验证码暂不可用');
      setCaptcha(await response.json()); setAnswer('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '验证码暂不可用'); }
  }
  useEffect(() => {
    let active = true;
    void fetch('/api/creator/session', { cache: 'no-store' }).then(response => {
      if (!active) return;
      if (response.ok) setState('ready');
      else { setState('login'); void reloadCaptcha(); }
    }).catch(() => { if (active) { setState('login'); void reloadCaptcha(); } });
    return () => { active = false; };
  }, []);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !captcha || !answer) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/creator/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, captchaId: captcha.id, captchaAnswer: answer }) });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error === 'invalid_captcha' ? '图片验证码不正确，请重新输入' : body.error === 'invalid_credentials' ? '邮箱或密码不正确' : '登录失败，请稍后重试');
      }
      setState('ready'); window.location.reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '登录失败'); await reloadCaptcha(); }
    finally { setBusy(false); }
  }
  return <Dialog open={state === 'login'} onOpenChange={() => {}}>
    <DialogContent showCloseButton={false} className="max-w-md overflow-hidden border-border bg-card p-0 text-card-foreground shadow-xl" onEscapeKeyDown={event => event.preventDefault()} onPointerDownOutside={event => event.preventDefault()}>
      <div className="border-b border-border bg-muted/40 px-7 py-6"><BrandMark size={28}/><p className="mt-4 text-xl font-semibold">登录 Blow Flow</p><p className="mt-1 text-sm leading-6 text-muted-foreground">使用创作用户账户继续管理项目与助手任务。</p></div>
      <div className="px-7 pb-7 pt-6">
        <form onSubmit={event => void submit(event)} className="space-y-4">
          <DialogHeader className="sr-only"><DialogTitle>创作用户登录</DialogTitle><DialogDescription>输入邮箱、密码和图片验证码</DialogDescription></DialogHeader>
          <label className="block text-sm font-medium">邮箱<input type="email" autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)} className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"/></label>
          <label className="block text-sm font-medium">密码<input type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"/></label>
          <div><label htmlFor="creator-captcha" className="block text-sm font-medium">图片验证码</label><div className="mt-2 flex items-center gap-2"><input id="creator-captcha" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} required value={answer} onChange={event => setAnswer(event.target.value)} placeholder="4 位数字" className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"/>{captcha ? <Image unoptimized src={captcha.image} alt="图片验证码" width={122} height={40} className="h-10 w-[122px] rounded border object-contain"/> : <span className="h-10 w-[122px] rounded border bg-muted"/>}<button type="button" aria-label="更换验证码" onClick={() => void reloadCaptcha()} className="rounded p-2 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"><RefreshCw size={18}/></button></div></div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={busy || !captcha}>{busy ? <Loader2 className="animate-spin"/> : <ShieldCheck/>}登录</Button>
        </form>
      </div>
    </DialogContent>
  </Dialog>;
}
