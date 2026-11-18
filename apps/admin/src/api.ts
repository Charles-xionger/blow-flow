import { createAPIClient, createPublicAPIClient } from '@blow-flow/api-client'

export const publicClient = createPublicAPIClient('/v1')

export function adminClient(accessToken: string) {
  return createAPIClient('/v1', accessToken)
}
