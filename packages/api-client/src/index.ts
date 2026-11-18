import createClient from "openapi-fetch";
import type { paths } from "./schema.js";

export type { components, operations, paths } from "./schema.js";

export function createAPIClient(baseUrl: string, accessToken: string, fetcher?: typeof fetch) {
  return createClient<paths>({
    baseUrl,
    headers: { Authorization: `Bearer ${accessToken}` },
    fetch: fetcher,
  });
}

export function createPublicAPIClient(baseUrl: string) {
  return createClient<paths>({ baseUrl });
}
