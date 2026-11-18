import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { components } from '@blow-flow/api-client'
import { Activity, ShieldCheck, Sparkles } from 'lucide-react'
import { clearSession as removeStoredSession, getSession, login } from './auth'
import { adminClient } from './api'
import { mayEnterAdmin } from './access'
import { AdminConsole } from './admin-console'
import { Button } from './components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card'
import { Input } from './components/ui/input'

type Account = components['schemas']['User']

export function AdminApp() {
  const preview = import.meta.env.DEV && new URLSearchParams(window.location.search).has('preview')
  const [token, setToken] = useState<string | null>(null)
  const [account, setAccount] = useState<Account | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [otp, setOtp] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const clearSession = useCallback(() => {
    removeStoredSession()
    setToken(null)
    setAccount(null)
    setError('会话已失效，请重新登录。')
  }, [])

  useEffect(() => {
    let active = true
    async function load() {
      if (preview) { setLoading(false); return }
      const session = getSession()
      if (!session) { setLoading(false); return }
      try {
        const result = await adminClient(session.accessToken).GET('/me')
        if (result.error || !mayEnterAdmin(result.data?.user.role, result.data?.user.status, session.expiresAt <= Date.now())) throw new Error('forbidden')
        if (active) { setToken(session.accessToken); setAccount(result.data.user) }
      } catch { if (active) clearSession() }
      finally { if (active) setLoading(false) }
    }
    void load()
    return () => { active = false }
  }, [preview, clearSession])

  useEffect(() => {
    if (!token) return
    const timer = window.setInterval(() => {
      const session = getSession()
      if (!session) { clearSession(); return }
      void adminClient(token).GET('/me').then(result => {
        if (result.error || !mayEnterAdmin(result.data?.user.role, result.data?.user.status, false)) clearSession()
      }).catch(clearSession)
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [token, clearSession])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const session = await login(email.trim(), password, otp.trim())
      if (!mayEnterAdmin(session.user.role, session.user.status, false)) throw new Error('当前账户没有管理员权限。')
      setToken(session.accessToken)
      setAccount(session.user)
      setPassword('')
      setOtp('')
    } catch (cause) {
      removeStoredSession()
      setError(cause instanceof Error ? cause.message : '登录失败，请重试。')
    } finally { setBusy(false) }
  }

  if (loading) return <div className='grid min-h-svh place-items-center'>正在验证管理员身份…</div>
  if (!preview && (!token || !account)) return <div className='grid min-h-svh bg-[#f7f9fc] lg:grid-cols-[minmax(0,1fr)_minmax(520px,0.88fr)]'>
    <section className='relative hidden min-h-svh overflow-hidden bg-[#07132f] p-12 text-white lg:flex lg:flex-col lg:justify-between' aria-label='Blow Flow 品牌介绍'>
      <div className='pointer-events-none absolute -left-32 top-1/4 size-[34rem] rounded-full bg-blue-600/30 blur-[100px]' />
      <div className='pointer-events-none absolute -right-32 bottom-0 size-[34rem] rounded-full bg-cyan-400/20 blur-[100px]' />
      <div className='relative z-10 flex items-center gap-3'><span className='grid size-10 place-items-center rounded-xl border border-white/20 bg-white/10'><Activity className='size-5' /></span><span className='text-lg font-semibold tracking-tight'>Blow Flow</span></div>
      <div className='relative z-10 mx-auto w-full max-w-2xl'>
        <div className='relative mx-auto mb-7 grid aspect-square w-[min(100%,28rem)] place-items-center rounded-full border border-white/10 bg-[radial-gradient(circle,rgba(14,165,233,0.22),transparent_68%)]'>
          <div className='absolute inset-8 rounded-full border border-white/10' />
          <img src='/brand/blow-flow-mark.png' alt='Blow Flow 蓝色无限形品牌图像' className='relative w-[min(100%,20rem)] drop-shadow-[0_30px_70px_rgba(0,180,255,0.4)]' />
        </div>
        <div className='flex items-center gap-2 text-sm font-medium text-cyan-200'><Sparkles className='size-4' /> 生成运营后台</div>
        <h1 className='mt-4 text-4xl font-semibold leading-tight tracking-tight xl:text-5xl'>让每一次生成<br />都有迹可循。</h1>
        <p className='mt-5 max-w-lg text-sm leading-7 text-slate-300'>统一查看账户与审计记录，逐步接入生成任务和供应商成本，掌握平台的真实运行状态。</p>
      </div>
      <p className='relative z-10 text-xs text-slate-400'>© Blow Flow · Internal operations</p>
    </section>
    <main className='flex min-h-svh flex-col px-6 py-8 sm:px-12 lg:px-16'>
      <div className='flex items-center gap-2 text-sm font-semibold text-slate-900 lg:invisible'><img src='/brand/blow-flow-mark.png' alt='' className='size-7' /> Blow Flow</div>
      <div className='flex flex-1 items-center justify-center py-10'>
        <Card className='w-full max-w-md border-0 bg-transparent shadow-none'>
          <CardHeader className='px-0'><div className='mb-5 grid size-12 place-items-center rounded-2xl bg-slate-950 text-white shadow-lg shadow-slate-900/20'><ShieldCheck className='size-6' /></div><CardTitle className='text-3xl font-semibold tracking-tight'>登录生成运营后台</CardTitle><CardDescription className='pt-1 text-sm leading-6'>仅限内部管理员。使用账户密码和验证器中的动态验证码登录。</CardDescription></CardHeader>
          <CardContent className='px-0'><form className='space-y-5' onSubmit={event => void submit(event)}>
            <label className='block space-y-2 text-sm font-medium'>邮箱<Input type='email' autoComplete='username' required value={email} onChange={event => setEmail(event.target.value)} placeholder='admin@example.com' className='h-11 bg-white' /></label>
            <label className='block space-y-2 text-sm font-medium'>密码<Input type='password' autoComplete='current-password' required value={password} onChange={event => setPassword(event.target.value)} className='h-11 bg-white' /></label>
            <label className='block space-y-2 text-sm font-medium'>动态验证码<Input inputMode='numeric' pattern='[0-9]{6}' maxLength={6} autoComplete='one-time-code' required value={otp} onChange={event => setOtp(event.target.value)} placeholder='验证器中的 6 位数字' className='h-11 bg-white' /></label>
            {error && <p role='alert' className='text-sm text-destructive'>{error}</p>}
            <Button className='h-11 w-full' disabled={busy} type='submit'>{busy ? '登录中…' : '登录'}</Button>
          </form>
          <details className='mt-6 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 open:pb-4'>
            <summary className='cursor-pointer font-medium text-slate-800'>动态验证码从哪里获取？</summary>
            {import.meta.env.DEV ? <ol className='mt-3 list-decimal space-y-2 pl-5 leading-6'>
              <li>在项目根目录运行 <code className='rounded bg-slate-100 px-1 py-0.5'>pnpm admin:qr</code>。</li>
              <li>打开生成的二维码图片，用手机验证器 App 扫码。<code className='mt-1 block break-all rounded bg-slate-100 px-2 py-1 text-xs'>apps/api/.admin-totp-qr.local.png</code></li>
              <li>回到这里，输入 App 显示的 6 位数字。以后登录也从该 App 获取。</li>
            </ol> : <p className='mt-3 leading-6'>打开已绑定的手机验证器 App，输入其中显示的 6 位数字。如尚未绑定，请联系部署维护人员。</p>}
            {import.meta.env.DEV && <p className='mt-3 leading-6'>本机调试可运行 <code className='rounded bg-slate-100 px-1 py-0.5'>pnpm admin:code</code> 查看当前验证码。二维码只保存在本机，不会显示在公开登录页。</p>}
          </details>
          <p className='mt-6 text-center text-xs leading-5 text-slate-500'>普通创作用户的注册将在创作端开放，后台不提供自行注册。</p>
          </CardContent>
        </Card>
      </div>
      <p className='text-center text-xs text-slate-400'>安全访问 · Blow Flow</p>
    </main>
  </div>

  return <AdminConsole
    token={token ?? undefined}
    account={account ?? undefined}
    preview={preview}
    onUnauthorized={clearSession}
    onSignOut={() => {
      if (preview) { window.location.assign('/'); return }
      removeStoredSession()
      setToken(null)
      setAccount(null)
      setError('')
    }}
  />
}
