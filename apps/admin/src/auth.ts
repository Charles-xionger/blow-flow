import { UserManager } from 'oidc-client-ts'

const issuer = import.meta.env.VITE_OIDC_ISSUER
const clientId = import.meta.env.VITE_OIDC_CLIENT_ID
const audience = import.meta.env.VITE_OIDC_API_AUDIENCE
const mfaAcr = import.meta.env.VITE_OIDC_MFA_ACR

export const auth = issuer && clientId ? new UserManager({
  authority: issuer,
  client_id: clientId,
  redirect_uri: `${window.location.origin}/auth/callback`,
  post_logout_redirect_uri: window.location.origin,
  response_type: 'code',
  scope: import.meta.env.VITE_OIDC_SCOPE || 'openid email profile',
  extraQueryParams: audience ? { audience } : undefined,
}) : null

let callbackSession: ReturnType<NonNullable<typeof auth>['signinRedirectCallback']> | undefined

export function initialSession() {
  if (!auth) return Promise.resolve(null)
  if (window.location.pathname !== '/auth/callback') return auth.getUser()
  callbackSession ??= auth.signinRedirectCallback()
  return callbackSession
}

export function signIn() {
  return auth?.signinRedirect(mfaAcr ? { acr_values: mfaAcr } : undefined)
}
