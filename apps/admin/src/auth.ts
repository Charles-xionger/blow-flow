import type { components } from '@blow-flow/api-client'
import { publicClient } from './api'
import { saveSession } from './admin-session'

export { getSession, clearSession, ensureSession, signOut } from './admin-session'

type Account = components['schemas']['User']
type AdminSession = { accessToken: string; expiresAt: number; user: Account }

export async function loadCaptcha(): Promise<{ id: string; image: string }> {
  const result = await publicClient.GET('/auth/captcha')
  if (result.error || !result.data) {
    if (result.response.status === 429) throw new Error('图片请求过于频繁，请稍后再试。')
    throw new Error('图片验证码加载失败，请刷新重试。')
  }
  return result.data
}

export async function login(email: string, password: string, captchaId: string, captchaAnswer: string): Promise<AdminSession> {
  const result = await publicClient.POST('/auth/admin/login', { body: { email, password, captchaId, captchaAnswer } })
  if (result.error || !result.data) {
    if (result.response.status === 503) throw new Error('Go API 尚未配置管理员登录。')
    if (result.error?.error === 'invalid_captcha') throw new Error('图片验证码不正确或已过期，已为你换一张。')
    throw new Error('邮箱或密码不正确。')
  }
  return saveSession(result.data.accessToken, result.data.expiresIn, result.data.user)
}
