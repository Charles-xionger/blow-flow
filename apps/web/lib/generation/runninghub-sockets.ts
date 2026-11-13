import WebSocket from 'ws';

// A socket is only a hint to query the original task. It never writes task outcomes.
export class RunningHubSockets {
  private sockets = new Map<string, WebSocket>();

  has(id: string) { return this.sockets.get(id)?.readyState === WebSocket.OPEN; }

  connect(id: string, address: unknown, platformBase: string, wake: () => void) {
    if (this.sockets.has(id) || typeof address !== 'string') return;
    try {
      const url = new URL(address);
      const base = new URL(platformBase);
      const local = url.protocol === 'ws:' && base.protocol === 'http:' && url.hostname === base.hostname;
      if ((url.protocol !== 'wss:' && !local) || url.username || url.password) return;
      const socket = new WebSocket(url, { handshakeTimeout: 10_000, maxPayload: 1024 * 1024, followRedirects: false });
      this.sockets.set(id, socket);
      let opened = false;
      socket.on('open', () => { opened = true; });
      const finish = (queryNow: boolean) => {
        if (this.sockets.get(id) !== socket) return;
        this.sockets.delete(id);
        socket.terminate();
        if (queryNow) wake();
      };
      socket.on('message', (raw, binary) => {
        if (binary || this.sockets.get(id) !== socket) return;
        try {
          const message = JSON.parse(raw.toString());
          if (message.type === 'execution_success' || message.type === 'execution_error' ||
            (message.type === 'executing' && message.data?.node === null)) finish(true);
        } catch { /* Unknown platform messages cannot decide a task outcome. */ }
      });
      socket.on('error', () => finish(opened));
      socket.on('close', () => finish(opened));
    } catch { /* HTTP polling remains active if the address or connection is invalid. */ }
  }

  retain(ids: Set<string>) {
    for (const [id, socket] of this.sockets) {
      if (ids.has(id)) continue;
      this.sockets.delete(id);
      socket.terminate();
    }
  }

  close() { this.retain(new Set()); }
}
