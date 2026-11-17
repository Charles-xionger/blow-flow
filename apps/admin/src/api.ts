import { createAPIClient } from '@blow-flow/api-client'

export function adminClient(accessToken: string) {
  return createAPIClient('/v1', accessToken)
}
