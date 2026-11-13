import * as Sentry from '@sentry/nextjs';
import { sanitizeEvent } from './lib/telemetry/sanitize';
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: !!process.env.SENTRY_DSN,
  environment: process.env.APP_ENV,
  release: process.env.SENTRY_RELEASE,
  sendDefaultPii: false,
  tracesSampleRate: 0,
  beforeSend: sanitizeEvent,
});
