'use client';
import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';
export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => { Sentry.captureException(error); }, [error]);
  return <html lang="zh-CN"><body><h1>页面暂时无法显示</h1><button onClick={reset}>重试</button></body></html>;
}
