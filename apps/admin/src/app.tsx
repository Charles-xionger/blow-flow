import { useEffect, useState } from 'react'
import type { User } from 'oidc-client-ts'
import { Activity, ChartNoAxesCombined, ClipboardList, Coins, LogOut, ShieldCheck, Users } from 'lucide-react'
import { auth, initialSession, signIn } from './auth'
import { adminClient } from './api'
import { mayEnterAdmin } from './access'
import { Button } from './components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card'

type Section = 'overview' | 'tasks' | 'cost' | 'users' | 'audit'
type Account = { id: string; email: string; role: string; status: string; createdAt: string }
type AuditEvent = { id: string; action: string; actorId: string; targetId: string; occurredAt: string }

export function AdminApp() {
  const [session, setSession] = useState<User | null>(null)
  const [account, setAccount] = useState<Account | null>(null)
  const [section, setSection] = useState<Section>('overview')
  const [users, setUsers] = useState<Account[]>([])
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    async function load() {
      if (!auth) { setError('请配置托管身份服务与 API 地址。'); setLoading(false); return }
      try {
        const current = await initialSession()
        if (window.location.pathname === '/auth/callback') window.history.replaceState({}, '', '/')
        if (!current || current.expired) { setLoading(false); return }
        const result = await adminClient(current.access_token).GET('/me')
        if (result.error || !mayEnterAdmin(result.data?.user.role, result.data?.user.status, Boolean(current.expired))) throw new Error('当前账户没有管理员权限或尚未完成 MFA。')
        if (active) { setSession(current); setAccount(result.data.user); setLoading(false) }
      } catch { if (active) { setError('身份验证失败。请重新登录并完成 MFA。'); setLoading(false) } }
    }
    void load()
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!auth || !session) return
    const manager = auth
    const clear = () => { setSession(null); setAccount(null); setUsers([]); setEvents([]); setError('会话已失效，请重新登录。') }
    manager.events.addAccessTokenExpired(clear)
    manager.events.addUserSignedOut(clear)
    const timer = window.setInterval(() => {
      void adminClient(session.access_token).GET('/me').then(result => {
        if (result.error || !mayEnterAdmin(result.data?.user.role, result.data?.user.status, Boolean(session.expired))) clear()
      }).catch(clear)
    }, 30_000)
    return () => {
      manager.events.removeAccessTokenExpired(clear)
      manager.events.removeUserSignedOut(clear)
      window.clearInterval(timer)
    }
  }, [session])

  useEffect(() => {
    if (!session || (section !== 'users' && section !== 'audit')) return
    let active = true
    const client = adminClient(session.access_token)
    const request = section === 'users' ? client.GET('/admin/users') : client.GET('/admin/audit-events')
    void request.then(result => {
      if (!active) return
      if (result.error) { setError('管理数据加载失败，请检查登录状态。'); if (result.response.status === 401 || result.response.status === 403) { setSession(null); setAccount(null); setUsers([]); setEvents([]) } return }
      if (section === 'users' && result.data && 'users' in result.data) setUsers(result.data.users)
      if (section === 'audit' && result.data && 'events' in result.data) setEvents(result.data.events)
    })
    return () => { active = false }
  }, [session, section])

  if (loading) return <div className="grid min-h-svh place-items-center">正在验证管理员身份…</div>
  if (!session || !account) return <div className="grid min-h-svh place-items-center p-6"><Card className="w-full max-w-md"><CardHeader><CardTitle>生成运营后台</CardTitle><CardDescription>{error || '请使用管理员账户登录并完成 MFA。'}</CardDescription></CardHeader><CardContent>{auth && <Button onClick={() => void signIn()}>管理员登录</Button>}</CardContent></Card></div>

  const menu: { id: Section; title: string; icon: typeof Activity }[] = [
    { id: 'overview', title: '总览', icon: ChartNoAxesCombined },
    { id: 'tasks', title: '任务', icon: ClipboardList },
    { id: 'cost', title: '供应商成本', icon: Coins },
    { id: 'users', title: '用户', icon: Users },
    { id: 'audit', title: '审计记录', icon: ShieldCheck },
  ]
  const title = menu.find(item => item.id === section)?.title
  return <div className="flex min-h-svh bg-background text-foreground">
    <aside className="hidden w-64 shrink-0 border-r bg-sidebar p-4 md:block"><div className="mb-8 px-3 text-lg font-semibold">Blow Flow <span className="block text-xs font-normal text-muted-foreground">生成运营后台</span></div><nav className="space-y-1">{menu.map(item => <button key={item.id} onClick={() => setSection(item.id)} className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-accent ${section === item.id ? 'bg-accent font-medium' : ''}`}><item.icon size={18}/>{item.title}</button>)}</nav></aside>
    <div className="min-w-0 flex-1"><header className="flex items-center justify-between border-b px-6 py-4"><div className="font-semibold">{title}</div><div className="flex items-center gap-3 text-sm"><span>{account.email}</span><Button variant="outline" size="sm" onClick={() => void auth?.signoutRedirect()}><LogOut/>退出</Button></div></header><nav className="flex gap-2 overflow-x-auto border-b p-3 md:hidden">{menu.map(item => <Button key={item.id} size="sm" variant={section === item.id ? 'default' : 'ghost'} onClick={() => setSection(item.id)}>{item.title}</Button>)}</nav><main className="mx-auto max-w-6xl space-y-6 p-6"><div><h1 className="text-2xl font-semibold">{title}</h1><p className="text-sm text-muted-foreground">内部生成运营与账户管理</p></div>{error && <p role="alert" className="text-destructive">{error}</p>}
      {section === 'overview' && <Card><CardHeader><CardTitle>运营总览</CardTitle><CardDescription>任务事件与成本数据迁移后将在这里呈现。</CardDescription></CardHeader></Card>}
      {(section === 'tasks' || section === 'cost') && <Card><CardHeader><CardTitle>{title}</CardTitle><CardDescription>Go API 尚未提供该领域的权威数据接口。</CardDescription></CardHeader></Card>}
      {section === 'users' && <Card><CardHeader><CardTitle>用户账户</CardTitle><CardDescription>来自 Go API 的本地账户</CardDescription></CardHeader><CardContent><div className="space-y-2">{users.map(user => <div className="flex justify-between gap-4 border-b py-3 text-sm" key={user.id}><span>{user.email}</span><span>{user.role} · {user.status}</span></div>)}{users.length === 0 && <p className="text-sm text-muted-foreground">暂无账户记录</p>}</div></CardContent></Card>}
      {section === 'audit' && <Card><CardHeader><CardTitle>审计记录</CardTitle><CardDescription>管理员操作事件</CardDescription></CardHeader><CardContent><div className="space-y-2">{events.map(event => <div className="flex justify-between gap-4 border-b py-3 text-sm" key={event.id}><span>{event.action} · {event.targetId}</span><time>{new Date(event.occurredAt).toLocaleString()}</time></div>)}{events.length === 0 && <p className="text-sm text-muted-foreground">暂无审计事件</p>}</div></CardContent></Card>}
    </main></div>
  </div>
}
