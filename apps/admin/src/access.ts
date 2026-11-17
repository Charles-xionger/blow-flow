export function mayEnterAdmin(role: string | undefined, status: string | undefined, tokenExpired: boolean) {
  return role === 'admin' && status === 'active' && !tokenExpired
}
