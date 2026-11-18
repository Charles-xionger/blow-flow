import type { components } from '@blow-flow/api-client'
import { publicClient } from './api'

type Account = components['schemas']['User']
type AdminSession = { accessToken: string; expiresAt: number; user: Account }
const storageKey = 'blow-flow-admin-session'

export function getSession(): AdminSession | null {
  try {
    const value = window.sessionStorage.getItem(storageKey)
    if (!value) return null
    const session = JSON.parse(value) as AdminSession
    if (!session.accessToken || !session.user || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) {
      clearSession()
      return null
    }
    return session
  } catch {
    clearSession()
    return null
  }
}

export async function login(email: string, password: string, otp: string): Promise<AdminSession> {
  const result = await publicClient.POST('/auth/admin/login', { body: { email, password, otp } })
  if (result.error || !result.data) {
    if (result.response.status === 503) throw new Error('Go API 尚未配置管理员登录。')
    throw new Error('邮箱、密码或动态验证码不正确。')
  }
  const session = { accessToken: result.data.accessToken, expiresAt: Date.now() + result.data.expiresIn * 1000, user: result.data.user }
  window.sessionStorage.setItem(storageKey, JSON.stringify(session))
  return session
}

export function clearSession() {
  window.sessionStorage.removeItem(storageKey)
}
