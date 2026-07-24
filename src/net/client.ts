import type { ClientMsg, PlayerInfo, ServerMsg } from './protocol';

type Handlers = {
  onWelcome: (m: Extract<ServerMsg, { t: 'welcome' }>) => void;
  onPlayers: (players: PlayerInfo[]) => void;
  onPos: (id: string, x: number, y: number, state: string) => void;
  onHole: (hole: number, players: PlayerInfo[]) => void;
  onCountdown: (seconds: number) => void;
  onStatus: (status: NetStatus, detail?: string) => void;
};

export type NetStatus = 'offline' | 'connecting' | 'online' | 'error';

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

  private url(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  connect(room: string, name: string, hue: number, seed?: number): void {
    this.disconnect();
    this.setStatus('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url());
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
        case 'players':
          this.handlers.onPlayers(msg.players);
          break;
        case 'pos':
          this.handlers.onPos(msg.id, msg.x, msg.y, msg.state);
          break;
        case 'hole':
          this.handlers.onHole(msg.hole, msg.players);
          break;
        case 'countdown':
          this.handlers.onCountdown(msg.seconds);
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
      this.setStatus('error', 'Could not reach the game server. Is `npm run dev:server` running?');
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
