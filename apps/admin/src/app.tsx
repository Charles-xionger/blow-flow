import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { components } from '@blow-flow/api-client'
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
  if (!preview && (!token || !account)) return <div className='grid min-h-svh place-items-center bg-muted/40 p-6'>
    <Card className='w-full max-w-md shadow-lg'>
      <CardHeader><div className='mb-2 grid size-10 place-items-center rounded-lg bg-primary text-primary-foreground font-bold'>B</div><CardTitle className='text-xl'>登录生成运营后台</CardTitle><CardDescription>使用内部管理员账户与动态验证码登录。</CardDescription></CardHeader>
      <CardContent><form className='space-y-4' onSubmit={event => void submit(event)}>
        <label className='block space-y-2 text-sm font-medium'>邮箱<Input type='email' autoComplete='username' required value={email} onChange={event => setEmail(event.target.value)} placeholder='admin@example.com' /></label>
        <label className='block space-y-2 text-sm font-medium'>密码<Input type='password' autoComplete='current-password' required value={password} onChange={event => setPassword(event.target.value)} /></label>
        <label className='block space-y-2 text-sm font-medium'>动态验证码<Input inputMode='numeric' pattern='[0-9]{6}' maxLength={6} autoComplete='one-time-code' required value={otp} onChange={event => setOtp(event.target.value)} placeholder='6 位验证码' /></label>
        {error && <p role='alert' className='text-sm text-destructive'>{error}</p>}
        <Button className='w-full' disabled={busy} type='submit'>{busy ? '登录中…' : '登录'}</Button>
      </form></CardContent>
    </Card>
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
