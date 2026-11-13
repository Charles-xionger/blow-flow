/** Strict allowlist: no prompt, generated media, request body, cookies or tokens. */
export function sanitizeEvent<T extends {
  message?: string; request?: unknown; user?: unknown; extra?: unknown;
  breadcrumbs?: unknown; contexts?: unknown; tags?: Record<string, unknown>;
  exception?: { values?: Array<{ value?: string; stacktrace?: unknown }> };
}>(event: T): T {
  delete event.message;
  delete event.request;
  delete event.user;
  delete event.extra;
  delete event.breadcrumbs;
  delete event.contexts;
  event.tags = Object.fromEntries(Object.entries(event.tags ?? {})
    .filter(([key]) => ['service', 'request_id'].includes(key)));
  for (const exception of event.exception?.values ?? []) exception.value = '[redacted]';
  return event;
}
