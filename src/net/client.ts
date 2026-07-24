import type { ClientMsg, RoomState, ServerMsg } from './protocol';

type Handlers = {
  onWelcome: (m: Extract<ServerMsg, { t: 'welcome' }>) => void;
  onState: (state: RoomState) => void;
  onPos: (id: string, x: number, y: number, state: string) => void;
  onCountdown: (seconds: number) => void;
  onKicked: (reason: string) => void;
  onStatus: (status: NetStatus, detail?: string) => void;
};

export type NetStatus = 'offline' | 'connecting' | 'online' | 'error';

/**
 * Resolves the WebSocket endpoint.
 *
 * Priority:
 *   1. `VITE_WS_URL` baked in at build time — used when the client is hosted on a static
 *      CDN (Netlify/Vercel) and the game server lives on a separate origin.
 *   2. A runtime override in localStorage (`orbit-golf.serverUrl`) for quick testing.
 *   3. Same-origin `/ws` — the default when one Node process serves both (npm start / Render).
 */
function resolveWsUrl(): string {
  const buildTime = import.meta.env.VITE_WS_URL as string | undefined;
  let override: string | null = null;
  try {
    override = localStorage.getItem('orbit-golf.serverUrl');
  } catch {
    override = null;
  }
  const raw = (override || buildTime || '').trim();
  if (raw) {
    // Accept http(s):// or ws(s):// and normalise to a ws(s) URL ending in /ws.
    let url = raw.replace(/^http/, 'ws');
    if (!/^wss?:\/\//.test(url)) url = `wss://${url}`;
    if (!/\/ws$/.test(url)) url = url.replace(/\/$/, '') + '/ws';
    return url;
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

export class NetClient {
  private ws: WebSocket | null = null;
  private handlers: Handlers;
  private lastSent = 0;
  status: NetStatus = 'offline';
  selfId = '';
  room = '';

  constructor(handlers: Handlers) {
    this.handlers = handlers;
  }

  connect(room: string, name: string, hue: number, seed?: number): void {
    this.disconnect();
    this.setStatus('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(resolveWsUrl());
    } catch (err) {
      this.setStatus('error', String(err));
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.send({ t: 'join', room, name, hue, ...(seed !== undefined ? { seed } : {}) });
    });

    ws.addEventListener('message', (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMsg;
      } catch {
        return;
      }
      switch (msg.t) {
        case 'welcome':
          this.selfId = msg.id;
          this.room = msg.room;
          this.setStatus('online');
          this.handlers.onWelcome(msg);
          break;
        case 'state':
          this.handlers.onState(msg.state);
          break;
        case 'pos':
          this.handlers.onPos(msg.id, msg.x, msg.y, msg.state);
          break;
        case 'countdown':
          this.handlers.onCountdown(msg.seconds);
          break;
        case 'kicked':
          // Suppress the impending close's "offline" churn; the kick handler drives the UI.
          this.handlers.onKicked(msg.reason);
          this.disconnect();
          break;
      }
    });

    ws.addEventListener('close', () => {
      if (this.ws === ws) {
        this.ws = null;
        this.setStatus('offline');
      }
    });

    ws.addEventListener('error', () => {
      this.setStatus('error', 'Could not reach the game server. Is the multiplayer server running?');
    });
  }

  private setStatus(s: NetStatus, detail?: string): void {
    this.status = s;
    this.handlers.onStatus(s, detail);
  }

  disconnect(): void {
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.close();
    }
    this.selfId = '';
    this.room = '';
    this.setStatus('offline');
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Throttled position broadcast — ghosts only need ~20 Hz. */
  sendPos(x: number, y: number, state: string, now: number): void {
    if (!this.connected || now - this.lastSent < 50) return;
    this.lastSent = now;
    this.send({ t: 'pos', x, y, state });
  }
}
