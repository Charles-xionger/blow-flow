import { useEffect, useRef, useState } from 'react'
import type { components } from '@blow-flow/api-client'
import {
  Activity, ArrowRight, ChartNoAxesCombined, ChevronRight, ClipboardList,
  Coins, LogOut, Menu, PanelLeftClose, PanelLeftOpen, RefreshCw,
  ScrollText, ShieldCheck, Users, X,
} from 'lucide-react'
import { adminClient } from './api'
import { Badge } from './components/ui/badge'
import { Button } from './components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card'
import { Input } from './components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table'

type Account = components['schemas']['User']
type AuditEvent = components['schemas']['AuditEvent']
type Section = 'overview' | 'tasks' | 'cost' | 'users' | 'audit'
type Page<T> = { items: T[]; nextCursor?: string }
type Props = {
  token?: string
  account?: Account
  preview: boolean
  onSignOut: () => void
  onUnauthorized: () => void
}

const navigation: { id: Section; title: string; icon: typeof Activity; group: string }[] = [
  { id: 'overview', title: '总览', icon: ChartNoAxesCombined, group: '工作区' },
  { id: 'tasks', title: '生成任务', icon: ClipboardList, group: '工作区' },
  { id: 'cost', title: '供应商成本', icon: Coins, group: '工作区' },
  { id: 'users', title: '用户账户', icon: Users, group: '管理' },
  { id: 'audit', title: '审计记录', icon: ScrollText, group: '管理' },
]

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function StatusBadge({ status }: { status: Account['status'] }) {
  return <Badge variant={status === 'active' ? 'secondary' : 'destructive'}>{status === 'active' ? '正常' : '已禁用'}</Badge>
}

function DataNotice({ title, description }: { title: string; description: string }) {
  return <Card><CardHeader><CardTitle>{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader></Card>
}

function DisableDialog({ user, busy, error, onCancel, onConfirm }: {
  user: Account
  busy: boolean
  error: string
  onCancel: () => void
  onConfirm: (reason: string) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [reason, setReason] = useState('')
  useEffect(() => {
    dialog.current?.showModal()
    return () => dialog.current?.close()
  }, [])
  return <dialog ref={dialog} onClose={onCancel} className='m-auto w-[min(92vw,28rem)] rounded-xl border bg-background p-0 text-foreground shadow-xl backdrop:bg-black/50' aria-labelledby='disable-title'>
    <div className='space-y-5 p-6'>
      <div><h2 id='disable-title' className='text-lg font-semibold'>禁用用户</h2><p className='mt-1 text-sm text-muted-foreground'>禁用 {user.email} 后，该账户将无法继续访问受保护接口。操作会写入审计记录。</p></div>
      <label className='block space-y-2 text-sm font-medium'>原因<Input autoFocus value={reason} onChange={event => setReason(event.target.value)} placeholder='请输入禁用原因' maxLength={500} /></label>
      {error && <p role='alert' className='text-sm text-destructive'>{error}</p>}
      <div className='flex justify-end gap-2'><Button type='button' variant='outline' disabled={busy} onClick={onCancel}>取消</Button><Button type='button' variant='destructive' disabled={busy || !reason.trim()} onClick={() => onConfirm(reason.trim())}>{busy ? '处理中…' : '确认禁用'}</Button></div>
    </div>
  </dialog>
}

export function AdminConsole({ token, account, preview, onSignOut, onUnauthorized }: Props) {
  const [section, setSection] = useState<Section>('overview')
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [status, setStatus] = useState<'all' | Account['status']>('all')
  const [userCursors, setUserCursors] = useState([''])
  const [auditCursors, setAuditCursors] = useState([''])
  const [users, setUsers] = useState<Page<Account> | null>(null)
  const [events, setEvents] = useState<Page<AuditEvent> | null>(null)
  const [loadingUsers, setLoadingUsers] = useState(false)
  const [loadingEvents, setLoadingEvents] = useState(false)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [disableTarget, setDisableTarget] = useState<Account | null>(null)
  const [disableBusy, setDisableBusy] = useState(false)
  const [disableError, setDisableError] = useState('')

  const userCursor = userCursors[userCursors.length - 1]
  const auditCursor = auditCursors[auditCursors.length - 1]

  useEffect(() => {
    if (!token || (section !== 'overview' && section !== 'users')) return
    let active = true
    setLoadingUsers(true)
    const query = { limit: 20, cursor: section === 'users' ? userCursor || undefined : undefined, status: section === 'users' && status !== 'all' ? status : undefined }
    void adminClient(token).GET('/admin/users', { params: { query } }).then(result => {
      if (!active) return
      if (result.error) {
        if (result.response.status === 401 || result.response.status === 403) onUnauthorized()
        else { setUsers(null); setError('用户数据加载失败，请稍后重试。') }
      } else if (result.data) {
        setUsers({ items: result.data.users, nextCursor: result.data.nextCursor })
        setError('')
      }
    }).catch(() => { if (active) { setUsers(null); setError('用户数据加载失败，请检查 Go API。') } }).finally(() => { if (active) setLoadingUsers(false) })
    return () => { active = false }
  }, [token, section, userCursor, status, refresh, onUnauthorized])

  useEffect(() => {
    if (!token || (section !== 'overview' && section !== 'audit')) return
    let active = true
    setLoadingEvents(true)
    void adminClient(token).GET('/admin/audit-events', { params: { query: { limit: 20, cursor: section === 'audit' ? auditCursor || undefined : undefined } } }).then(result => {
      if (!active) return
      if (result.error) {
        if (result.response.status === 401 || result.response.status === 403) onUnauthorized()
        else { setEvents(null); setError('审计数据加载失败，请稍后重试。') }
      } else if (result.data) {
        setEvents({ items: result.data.events, nextCursor: result.data.nextCursor })
        setError('')
      }
    }).catch(() => { if (active) { setEvents(null); setError('审计数据加载失败，请检查 Go API。') } }).finally(() => { if (active) setLoadingEvents(false) })
    return () => { active = false }
  }, [token, section, auditCursor, refresh, onUnauthorized])

  async function disableUser(reason: string) {
    if (!token || !disableTarget) return
    setDisableBusy(true)
    setDisableError('')
    try {
      const result = await adminClient(token).POST('/admin/users/{userId}/disable', { params: { path: { userId: disableTarget.id } }, body: { reason } })
      if (result.error) {
        if (result.response.status === 401) onUnauthorized()
        else if (result.error.error === 'recent_auth_required') setDisableError('登录已超过 10 分钟，请重新登录后再试。')
        else setDisableError('禁用失败，请检查账户状态后重试。')
        return
      }
      setDisableTarget(null)
      setRefresh(value => value + 1)
    } catch { setDisableError('禁用失败，请检查 Go API。') }
    finally { setDisableBusy(false) }
  }

  const title = navigation.find(item => item.id === section)?.title ?? '总览'
  const previewMessage = '页面预览不连接管理接口。正式登录后显示真实账户和审计数据。'
  return <div className='flex min-h-svh bg-background text-foreground'>
    {mobileOpen && <button className='fixed inset-0 z-30 bg-black/40 md:hidden' aria-label='关闭导航' onClick={() => setMobileOpen(false)} />}
    <aside className={`fixed inset-y-0 left-0 z-40 flex flex-col border-r bg-sidebar transition-[width,transform] duration-200 md:sticky md:translate-x-0 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'} ${collapsed ? 'w-64 md:w-16' : 'w-64'}`}>
      <div className='flex h-16 items-center gap-3 border-b px-4'>
        <div className='grid size-9 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground'><Activity className='size-5' /></div>
        <div className={`min-w-0 ${collapsed ? 'md:hidden' : ''}`}><div className='truncate text-sm font-semibold'>Blow Flow</div><div className='truncate text-xs text-muted-foreground'>生成运营后台</div></div>
        <Button variant='ghost' size='icon' className='ml-auto md:hidden' aria-label='关闭菜单' onClick={() => setMobileOpen(false)}><X /></Button>
      </div>
      <div className='flex-1 overflow-y-auto px-3 py-5'>
        {['工作区', '管理'].map(group => <div key={group} className='mb-6'><p className={`mb-2 px-3 text-xs font-medium text-muted-foreground ${collapsed ? 'md:sr-only' : ''}`}>{group}</p><nav className='space-y-1' aria-label={group}>{navigation.filter(item => item.group === group).map(item => <button key={item.id} title={item.title} onClick={() => { setSection(item.id); setMobileOpen(false); setError('') }} className={`flex h-9 w-full items-center gap-3 rounded-md px-3 text-left text-sm transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground ${section === item.id ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground' : 'text-sidebar-foreground'}`}><item.icon className='size-4 shrink-0' /><span className={collapsed ? 'md:sr-only' : ''}>{item.title}</span></button>)}</nav></div>)}
      </div>
      <div className='border-t p-3'><div className='flex items-center gap-3 rounded-md p-2'><div className='grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-xs font-semibold'>{account?.email.slice(0, 2).toUpperCase() ?? 'DE'}</div><div className={`min-w-0 flex-1 ${collapsed ? 'md:hidden' : ''}`}><div className='truncate text-sm font-medium'>{account?.email ?? '开发预览'}</div><div className='text-xs text-muted-foreground'>{preview ? '仅页面预览' : '管理员'}</div></div></div></div>
    </aside>
    <div className='min-w-0 flex-1'>
      <header className='flex h-16 items-center justify-between gap-4 border-b px-4 sm:px-6'>
        <div className='flex min-w-0 items-center gap-3'><Button variant='ghost' size='icon' className='md:hidden' aria-label='打开菜单' onClick={() => setMobileOpen(true)}><Menu /></Button><Button variant='ghost' size='icon' className='hidden md:inline-flex' aria-label={collapsed ? '展开侧栏' : '收起侧栏'} onClick={() => setCollapsed(value => !value)}>{collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</Button><span className='hidden text-sm text-muted-foreground sm:inline'>生成运营后台</span><ChevronRight className='hidden size-4 text-muted-foreground sm:inline' /><span className='truncate text-sm font-medium'>{title}</span></div>
        <div className='flex items-center gap-2'><Button variant='ghost' size='icon' aria-label='刷新当前页面' disabled={preview || section === 'tasks' || section === 'cost'} onClick={() => setRefresh(value => value + 1)}><RefreshCw /></Button><Button variant='outline' size='sm' onClick={onSignOut}><LogOut />{preview ? '退出预览' : '退出'}</Button></div>
      </header>
      <main className='mx-auto max-w-7xl space-y-6 p-4 sm:p-6'>
        {preview && <div role='status' className='rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950'>{previewMessage}</div>}
        {error && <div role='alert' className='rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive'>{error}</div>}
        <div className='flex items-end justify-between gap-4'><div><h1 className='text-2xl font-bold tracking-tight'>{title}</h1><p className='mt-1 text-sm text-muted-foreground'>{section === 'overview' ? '平台账户与生成运营概况' : section === 'users' ? '查看和处理平台账户' : section === 'audit' ? '管理员操作的不可变记录' : '生成领域迁移后接入权威数据'}</p></div></div>
        {section === 'overview' && <>
          <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-4'>
            <Card><CardHeader className='flex flex-row items-center justify-between pb-2'><CardTitle className='text-sm font-medium'>本页用户账户</CardTitle><Users className='size-4 text-muted-foreground' /></CardHeader><CardContent><div className='text-2xl font-bold'>{preview ? '—' : loadingUsers ? '…' : users?.items.length ?? '—'}</div><p className='text-xs text-muted-foreground'>来自 Go API，最多显示最近 20 条</p></CardContent></Card>
            <Card><CardHeader className='flex flex-row items-center justify-between pb-2'><CardTitle className='text-sm font-medium'>本页审计事件</CardTitle><ShieldCheck className='size-4 text-muted-foreground' /></CardHeader><CardContent><div className='text-2xl font-bold'>{preview ? '—' : loadingEvents ? '…' : events?.items.length ?? '—'}</div><p className='text-xs text-muted-foreground'>来自 Go API，最多显示最近 20 条</p></CardContent></Card>
            <Card><CardHeader className='flex flex-row items-center justify-between pb-2'><CardTitle className='text-sm font-medium'>生成任务</CardTitle><ClipboardList className='size-4 text-muted-foreground' /></CardHeader><CardContent><div className='text-lg font-semibold'>待接入</div><p className='text-xs text-muted-foreground'>任务权威接口尚未迁移</p></CardContent></Card>
            <Card><CardHeader className='flex flex-row items-center justify-between pb-2'><CardTitle className='text-sm font-medium'>供应商成本</CardTitle><Coins className='size-4 text-muted-foreground' /></CardHeader><CardContent><div className='text-lg font-semibold'>待接入</div><p className='text-xs text-muted-foreground'>成本权威接口尚未迁移</p></CardContent></Card>
          </div>
          <div className='grid gap-4 lg:grid-cols-2'>
            <Card><CardHeader><CardTitle>最近用户</CardTitle><CardDescription>账户域的真实数据</CardDescription></CardHeader><CardContent>{preview ? <p className='text-sm text-muted-foreground'>{previewMessage}</p> : loadingUsers ? <p className='text-sm text-muted-foreground'>加载中…</p> : users?.items.length ? <div className='space-y-3'>{users.items.slice(0, 5).map(user => <div key={user.id} className='flex items-center justify-between gap-3 border-b pb-3 text-sm last:border-0 last:pb-0'><span className='truncate'>{user.email}</span><StatusBadge status={user.status} /></div>)}</div> : <p className='text-sm text-muted-foreground'>暂无账户记录</p>}<Button variant='link' className='mt-3 px-0' onClick={() => setSection('users')}>查看账户 <ArrowRight /></Button></CardContent></Card>
            <Card><CardHeader><CardTitle>最近审计事件</CardTitle><CardDescription>管理员操作记录</CardDescription></CardHeader><CardContent>{preview ? <p className='text-sm text-muted-foreground'>{previewMessage}</p> : loadingEvents ? <p className='text-sm text-muted-foreground'>加载中…</p> : events?.items.length ? <div className='space-y-3'>{events.items.slice(0, 5).map(event => <div key={event.id} className='flex items-center justify-between gap-3 border-b pb-3 text-sm last:border-0 last:pb-0'><span className='truncate'>{event.action}</span><time className='shrink-0 text-xs text-muted-foreground'>{formatDate(event.occurredAt)}</time></div>)}</div> : <p className='text-sm text-muted-foreground'>暂无审计事件</p>}<Button variant='link' className='mt-3 px-0' onClick={() => setSection('audit')}>查看审计 <ArrowRight /></Button></CardContent></Card>
          </div>
        </>}
        {(section === 'tasks' || section === 'cost') && <DataNotice title={title} description='Go API 尚未提供该领域的权威接口。迁移完成后在这里展示真实数据与操作。' />}
        {section === 'users' && <Card><CardHeader className='flex flex-row flex-wrap items-center justify-between gap-4'><div><CardTitle>用户账户</CardTitle><CardDescription className='mt-1'>按创建时间倒序，来自 Go API</CardDescription></div><select aria-label='账户状态' value={status} onChange={event => { setStatus(event.target.value as typeof status); setUserCursors(['']) }} className='h-9 rounded-md border border-input bg-background px-3 text-sm'><option value='all'>全部状态</option><option value='active'>正常</option><option value='disabled'>已禁用</option></select></CardHeader><CardContent>{preview ? <p className='text-sm text-muted-foreground'>{previewMessage}</p> : loadingUsers ? <p className='text-sm text-muted-foreground'>加载中…</p> : <><Table><TableHeader><TableRow><TableHead>邮箱</TableHead><TableHead>角色</TableHead><TableHead>状态</TableHead><TableHead>创建时间</TableHead><TableHead className='text-right'>操作</TableHead></TableRow></TableHeader><TableBody>{users?.items.map(user => <TableRow key={user.id}><TableCell className='font-medium'>{user.email}</TableCell><TableCell>{user.role === 'admin' ? '管理员' : '用户'}</TableCell><TableCell><StatusBadge status={user.status} /></TableCell><TableCell className='text-muted-foreground'>{formatDate(user.createdAt)}</TableCell><TableCell className='text-right'><Button size='sm' variant='outline' disabled={user.status !== 'active' || user.id === account?.id} onClick={() => { setDisableError(''); setDisableTarget(user) }}>禁用</Button></TableCell></TableRow>)}</TableBody></Table>{!users?.items.length && <p className='py-8 text-center text-sm text-muted-foreground'>没有符合条件的账户</p>}<div className='mt-4 flex items-center justify-end gap-2 text-sm text-muted-foreground'><span>第 {userCursors.length} 页</span><Button size='sm' variant='outline' disabled={userCursors.length === 1} onClick={() => setUserCursors(value => value.slice(0, -1))}>上一页</Button><Button size='sm' variant='outline' disabled={!users?.nextCursor} onClick={() => { if (users?.nextCursor) setUserCursors(value => [...value, users.nextCursor!]) }}>下一页</Button></div></>}</CardContent></Card>}
        {section === 'audit' && <Card><CardHeader><CardTitle>审计记录</CardTitle><CardDescription>按发生时间倒序，来自 Go API</CardDescription></CardHeader><CardContent>{preview ? <p className='text-sm text-muted-foreground'>{previewMessage}</p> : loadingEvents ? <p className='text-sm text-muted-foreground'>加载中…</p> : <><Table><TableHeader><TableRow><TableHead>操作</TableHead><TableHead>对象</TableHead><TableHead>操作者</TableHead><TableHead>时间</TableHead></TableRow></TableHeader><TableBody>{events?.items.map(event => <TableRow key={event.id}><TableCell className='font-medium'>{event.action}</TableCell><TableCell className='text-muted-foreground'>{event.targetType} · {event.targetId}</TableCell><TableCell className='text-muted-foreground'>{event.actorId}</TableCell><TableCell className='text-muted-foreground'>{formatDate(event.occurredAt)}</TableCell></TableRow>)}</TableBody></Table>{!events?.items.length && <p className='py-8 text-center text-sm text-muted-foreground'>暂无审计记录</p>}<div className='mt-4 flex items-center justify-end gap-2 text-sm text-muted-foreground'><span>第 {auditCursors.length} 页</span><Button size='sm' variant='outline' disabled={auditCursors.length === 1} onClick={() => setAuditCursors(value => value.slice(0, -1))}>上一页</Button><Button size='sm' variant='outline' disabled={!events?.nextCursor} onClick={() => { if (events?.nextCursor) setAuditCursors(value => [...value, events.nextCursor!]) }}>下一页</Button></div></>}</CardContent></Card>}
        <footer className='border-t pt-4 text-xs text-muted-foreground'>Blow Flow · 生成运营后台</footer>
      </main>
    </div>
    {disableTarget && !preview && <DisableDialog user={disableTarget} busy={disableBusy} error={disableError} onCancel={() => setDisableTarget(null)} onConfirm={reason => void disableUser(reason)} />}
  </div>
}
