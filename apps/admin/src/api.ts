import { createAPIClient, createPublicAPIClient } from '@blow-flow/api-client'
import { ensureSession, refreshSession } from './admin-session'

export const publicClient = createPublicAPIClient('/v1')

export function adminClient(accessToken: string) {
  const authenticatedFetch: typeof fetch = async (input, init) => {
    const original = new Request(input, init)
    const retry = original.clone()
    const session = await ensureSession()
    const headers = new Headers(original.headers)
    headers.set('Authorization', `Bearer ${session?.accessToken ?? accessToken}`)
    let response = await fetch(new Request(original, { headers }))
    if (response.status !== 401) return response
    const renewed = await refreshSession()
    if (!renewed) return response
    const retryHeaders = new Headers(retry.headers)
    retryHeaders.set('Authorization', `Bearer ${renewed.accessToken}`)
    response = await fetch(new Request(retry, { headers: retryHeaders }))
    return response
  }
  return createAPIClient(`${window.location.origin}/v1`, accessToken, authenticatedFetch)
}
