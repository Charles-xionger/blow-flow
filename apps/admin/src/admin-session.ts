import type { components } from '@blow-flow/api-client'

type Account = components['schemas']['User']
export type AdminSession = { accessToken: string; expiresAt: number; user: Account }
const storageKey = 'blow-flow-admin-session'
let refreshing: Promise<AdminSession | null> | null = null
let sessionEpoch = 0

export function getSession(): AdminSession | null {
  try {
    const value = window.sessionStorage.getItem(storageKey)
    if (!value) return null
    const session = JSON.parse(value) as AdminSession
    if (!session.accessToken || !session.user || !Number.isFinite(session.expiresAt)) return null
    return session
  } catch { return null }
}

export function saveSession(accessToken: string, expiresIn: number, user: Account): AdminSession {
  sessionEpoch++
  const session = { accessToken, expiresAt: Date.now() + expiresIn * 1000, user }
  window.sessionStorage.setItem(storageKey, JSON.stringify(session))
  return session
}

export function clearSession() { sessionEpoch++; window.sessionStorage.removeItem(storageKey) }

export async function refreshSession(): Promise<AdminSession | null> {
  if (refreshing) return refreshing
  const epoch = sessionEpoch
  refreshing = (async () => {
    const response = await fetch('/v1/auth/admin/refresh', { method: 'POST', credentials: 'same-origin' })
    if (response.status === 401) { if (epoch === sessionEpoch) clearSession(); return null }
    if (!response.ok) throw new Error('Refresh temporarily unavailable')
    const data = await response.json() as { accessToken: string; expiresIn: number; user: Account }
    if (epoch !== sessionEpoch) return null
    return saveSession(data.accessToken, data.expiresIn, data.user)
  })().finally(() => { refreshing = null })
  return refreshing
}

export async function ensureSession(): Promise<AdminSession | null> {
  const current = getSession()
  if (current && current.expiresAt - Date.now() > 60_000) return current
  return refreshSession()
}

export async function signOut() {
  try { await refreshing } catch { /* The refresh request may have failed before logout. */ }
  try { await fetch('/v1/auth/admin/logout', { method: 'POST', credentials: 'same-origin' }) }
  finally { clearSession() }
}
