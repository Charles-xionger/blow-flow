import { afterEach, expect, it, vi } from 'vitest'
import { adminClient } from './api'
import { clearSession, ensureSession, getSession, saveSession, signOut } from './admin-session'

afterEach(() => { vi.unstubAllGlobals() })

it('refreshes and retries a protected request after access token expiry', async () => {
  const values = new Map<string,string>()
  vi.stubGlobal('window', { location: { origin: 'http://localhost' }, sessionStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key,value) },
    removeItem: (key: string) => { values.delete(key) },
  } })
  const user = { id:'admin-1', email:'admin@example.com', role:'admin', status:'active', createdAt:'2026-01-01', updatedAt:'2026-01-01' } as const
  saveSession('old', 900, user)
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.endsWith('/auth/admin/refresh')) {
      calls.push('refresh')
      return Response.json({ accessToken:'new', expiresIn:900, user })
    }
    calls.push(input instanceof Request ? input.headers.get('Authorization') ?? '' : '')
    if (calls.length===1) return Response.json({ error:'unauthorized' },{ status:401 })
    return Response.json({ user })
  }))
  const result = await adminClient('old').GET('/me')
  expect(result.data?.user.id).toBe('admin-1')
  expect(calls).toEqual(['Bearer old','refresh','Bearer new'])
  clearSession()
})

it('keeps the stored session during a temporary refresh outage', async () => {
  const values = new Map<string,string>()
  vi.stubGlobal('window', { sessionStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key,value) },
    removeItem: (key: string) => { values.delete(key) },
  } })
  const user = { id:'admin-1', email:'admin@example.com', role:'admin', status:'active', createdAt:'2026-01-01', updatedAt:'2026-01-01' } as const
  saveSession('old',-1,user)
  vi.stubGlobal('fetch',vi.fn(async () => Response.json({error:'service_unavailable'},{status:503})))
  await expect(ensureSession()).rejects.toThrow('Refresh temporarily unavailable')
  expect(getSession()?.accessToken).toBe('old')
  clearSession()
})

it('keeps the session when logout cannot revoke it on the server', async () => {
  const values = new Map<string,string>()
  vi.stubGlobal('window', { sessionStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key,value) },
    removeItem: (key: string) => { values.delete(key) },
  } })
  const user = { id:'admin-1', email:'admin@example.com', role:'admin', status:'active', createdAt:'2026-01-01', updatedAt:'2026-01-01' } as const
  saveSession('still-valid',900,user)
  vi.stubGlobal('fetch',vi.fn(async () => Response.json({error:'service_unavailable'},{status:503})))
  await expect(signOut()).rejects.toThrow('Logout temporarily unavailable')
  expect(getSession()?.accessToken).toBe('still-valid')
  clearSession()
})
