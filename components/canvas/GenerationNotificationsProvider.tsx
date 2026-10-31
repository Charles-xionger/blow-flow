'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { GenerationNotifications, type NotificationState } from '@/lib/generation/notifications';

const NotificationsContext = createContext<GenerationNotifications | null>(null);

export function GenerationNotificationsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<NotificationState>('connecting');
  const [notifications] = useState(() => new GenerationNotifications(undefined, setState));
  useEffect(() => () => notifications.close(), [notifications]);
  return <NotificationsContext.Provider value={notifications}>
    {children}
    {state === 'polling' && <div role="status" className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-amber-950 px-4 py-2 text-sm text-amber-100 shadow-lg">
      实时连接暂不可用，正在每 10 秒同步生成结果；后台任务继续执行。
    </div>}
  </NotificationsContext.Provider>;
}

export function useGenerationNotifications() {
  const notifications = useContext(NotificationsContext);
  if (!notifications) throw new Error('生成任务需要画布通知上下文');
  return notifications;
}
