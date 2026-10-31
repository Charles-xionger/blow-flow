import { fetchEventSource } from '@microsoft/fetch-event-source';
import { generationActive, getGeneration } from './client';
import type { GenerationTask } from './types';

type Message = (event: string, tasks: GenerationTask[]) => void;
interface NotificationIO {
  stream: (ids: string[], signal: AbortSignal, message: Message) => Promise<void>;
  get: (id: string, signal: AbortSignal) => Promise<GenerationTask>;
}
const browserIO: NotificationIO = {
  get: getGeneration,
  stream: (ids, signal, message) => fetchEventSource('/api/generation/events', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskIds: ids }),
    signal, openWhenHidden: true,
    async onopen(response) {
      if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream'))
        throw new Error('通知连接不可用');
    },
    onmessage(event) { message(event.event, JSON.parse(event.data)); },
    onclose() { throw new Error('通知连接已关闭'); },
    // The canvas owns retry timing and detects stalled connections as well as errors.
    onerror(error) { throw error; },
  }),
};

export type NotificationState = 'connecting' | 'connected' | 'polling';

export class GenerationNotifications {
  private listeners = new Map<string, Set<(task: GenerationTask) => void>>();
  private latest = new Map<string, GenerationTask>();
  private connection?: AbortController;
  private scheduled = false;

  private timer?: ReturnType<typeof setInterval>;
  private state: NotificationState = 'connecting';
  private healthy = false;
  private outageAt = Date.now();
  private activityAt = Date.now();
  private retryAt = 0;
  private pollAt = 0;
  private polls = new Map<string, AbortController>();

  constructor(private io: NotificationIO = browserIO, private onState: (state: NotificationState) => void = () => {}) {}

  private setState(state: NotificationState) {
    if (this.state !== state) { this.state = state; this.onState(state); }
  }

  private tick() {
    const now = Date.now();
    if (this.connection && now - this.activityAt >= (this.healthy ? 25_000 : 15_000)) {
      this.connection.abort(); this.connection = undefined;
      if (this.healthy) this.outageAt = this.activityAt;
      this.healthy = false;
      this.retryAt = now;
    }
    if (!this.healthy && now - this.outageAt >= 15_000) this.setState('polling');
    if (!this.connection && now >= this.retryAt) this.connect();
    if (this.state === 'polling' && now >= this.pollAt) {
      this.pollAt = now + 10_000;
      for (const id of this.listeners.keys()) {
        const latest = this.latest.get(id);
        if (this.polls.has(id) || (latest && !generationActive(latest))) continue;
        const controller = new AbortController();
        this.polls.set(id, controller);
        void this.io.get(id, controller.signal).then(task => {
          if (!controller.signal.aborted && this.state === 'polling') this.deliver(task);
        }).catch(() => {}).finally(() => {
          if (this.polls.get(id) === controller) this.polls.delete(id);
        });
      }
    }
  }

  subscribe(id: string, receive: (task: GenerationTask) => void) {
    if (!this.timer) {
      this.outageAt = Date.now();
      this.timer = setInterval(() => this.tick(), 1000);
    }
    let listeners = this.listeners.get(id);
    if (!listeners) { listeners = new Set(); this.listeners.set(id, listeners); this.schedule(); }
    listeners.add(receive);
    const latest = this.latest.get(id);
    if (latest) receive(latest);
    return () => {
      listeners.delete(receive);
      if (!listeners.size) {
        this.listeners.delete(id); this.latest.delete(id);
        this.polls.get(id)?.abort(); this.polls.delete(id);
        if (!this.listeners.size) this.close(); else this.schedule();
      }
    };
  }

  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.connect(); });
  }

  private deliver(task: GenerationTask) {
    const previous = this.latest.get(task.id);
    if (previous && previous.revision >= task.revision) return;
    if (!this.listeners.has(task.id)) return;
    this.latest.set(task.id, task);
    for (const listener of this.listeners.get(task.id)!) listener(task);
  }

  private connect() {
    this.connection?.abort();
    this.connection = undefined;
    if (!this.listeners.size) return;
    if (this.healthy) this.outageAt = Date.now();
    this.healthy = false;
    this.activityAt = Date.now();
    const connection = this.connection = new AbortController();
    void this.io.stream([...this.listeners.keys()], connection.signal, (event, tasks) => {
      if (this.connection !== connection || connection.signal.aborted) return;
      if (!['snapshot', 'tasks', 'heartbeat'].includes(event) || !Array.isArray(tasks)) return;
      this.activityAt = Date.now();
      if (event === 'snapshot') {
        this.healthy = true;
        for (const controller of this.polls.values()) controller.abort();
        this.polls.clear();
        this.setState('connected');
      }
      if (event === 'snapshot' || event === 'tasks') for (const task of tasks) this.deliver(task);
    }).catch(() => {}).finally(() => {
      if (this.connection !== connection || connection.signal.aborted) return;
      this.connection = undefined;
      if (this.healthy) this.outageAt = Date.now();
      this.healthy = false;
      this.retryAt = Date.now() + 3000;
      if (this.state !== 'polling') this.setState('connecting');
    });
  }

  refresh(id: string) {
    this.latest.delete(id);
    if (this.listeners.has(id)) this.schedule();
  }

  close() {
    clearInterval(this.timer); this.timer = undefined;
    for (const controller of this.polls.values()) controller.abort();
    this.polls.clear();
    this.healthy = false;
    this.pollAt = 0;
    this.setState('connecting');
    this.connection?.abort();
    this.connection = undefined;
    this.listeners.clear();
    this.latest.clear();
  }
}
