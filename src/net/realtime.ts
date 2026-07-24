import { hashString } from '../core/rng';
import { isMultiplayerConfigured } from './config';
import {
  DEFAULT_ROOM_CONFIG,
  type CountdownPayload,
  type KickPayload,
  type PlayerInfo,
  type PosPayload,
  type PresenceMeta,
  type RoomConfig,
  type RoomMeta,
  type RoomState,
  type StatePayload,
} from './protocol';
import {
  memoryTransportFactory,
  supabaseTransportFactory,
  type PresenceMap,
  type Transport,
  type TransportFactory,
  type TransportStatus,
} from './transport';

export type NetStatus = 'offline' | 'connecting' | 'online' | 'error';

export interface RealtimeHandlers {
  onWelcome: (m: { id: string; room: string; seed: number; state: RoomState }) => void;
  onState: (state: RoomState) => void;
  onPos: (id: string, x: number, y: number, state: string) => void;
  onCountdown: (seconds: number) => void;
  onKicked: (reason: string) => void;
  onStatus: (status: NetStatus, detail?: string) => void;
}

/** Countdown before the room rolls to the next hole. Overridable so tests don't wait 4s. */
export let advanceDelayMs = 4000;
export function setAdvanceDelay(ms: number): void {
  advanceDelayMs = ms;
}

/**
 * Serverless multiplayer over Supabase Realtime.
 *
 * There is no authoritative server, so responsibilities are split:
 *  - Presence carries the player roster and each player's score (low frequency).
 *  - The course seed is derived from the room code, so every client agrees with no
 *    coordination.
 *  - The **host** is elected deterministically as the earliest joiner (tie-broken by id),
 *    which every client computes identically from Presence. The host owns the mutable
 *    room state (phase / hole / config), broadcasts it, and runs hole advancement.
 *  - Clients only accept room state from whoever Presence says is the host, so a rogue
 *    client cannot impersonate one.
 */
export class RealtimeClient {
  private transport: Transport | null = null;
  private handlers: RealtimeHandlers;
  private factory: TransportFactory;

  status: NetStatus = 'offline';
  selfId = '';
  room = '';

  private meta: PresenceMeta = blankMeta();
  private presence: PresenceMap = {};
  private roomMeta: RoomMeta = { phase: 'lobby', hole: 1, config: { ...DEFAULT_ROOM_CONFIG } };

  private knownMembers = new Set<string>();
  private lastHost = '';
  private advanceTimer: ReturnType<typeof setTimeout> | null = null;
  private welcomed = false;
  private lastPosSent = 0;

  constructor(handlers: RealtimeHandlers, factory?: TransportFactory) {
    this.handlers = handlers;
    // Tests/browser smoke can force the in-memory relay via a global flag.
    const forced = (globalThis as { __ORBIT_MEMORY_NET?: boolean }).__ORBIT_MEMORY_NET;
    this.factory = factory ?? (forced ? memoryTransportFactory : supabaseTransportFactory);
  }

  get connected(): boolean {
    return this.status === 'online';
  }

  get amHost(): boolean {
    return this.connected && this.selfId !== '' && this.electHost() === this.selfId;
  }

  // ------------------------------------------------------------- connection

  connect(room: string, name: string, hue: number): void {
    this.disconnect();
    const code = room.trim().toUpperCase().slice(0, 12) || 'LOBBY';
    const usingMemory = Boolean((globalThis as { __ORBIT_MEMORY_NET?: boolean }).__ORBIT_MEMORY_NET) || this.factory === memoryTransportFactory;
    if (!usingMemory && !isMultiplayerConfigured()) {
      this.setStatus('error', 'Multiplayer is not configured (missing Supabase env vars).');
      return;
    }

    this.selfId = randomId();
    this.room = code;
    this.welcomed = false;
    this.knownMembers.clear();
    this.lastHost = '';
    this.roomMeta = { phase: 'lobby', hole: 1, config: { ...DEFAULT_ROOM_CONFIG } };
    this.meta = { ...blankMeta(), id: this.selfId, name: name.slice(0, 18) || 'Player', hue, joinedAt: Date.now() };

    this.setStatus('connecting');
    const t = this.factory(code, this.selfId);
    this.transport = t;
    t.onStatus((s, detail) => this.onTransportStatus(s, detail));
    t.onPresence((p) => this.onPresence(p));
    t.onMessage((event, payload) => this.onMessage(event, payload));
    t.subscribe();
  }

  disconnect(): void {
    if (this.advanceTimer) {
      clearTimeout(this.advanceTimer);
      this.advanceTimer = null;
    }
    if (this.transport) {
      const t = this.transport;
      this.transport = null;
      t.close();
    }
    this.selfId = '';
    this.room = '';
    this.presence = {};
    this.knownMembers.clear();
    this.welcomed = false;
    this.setStatus('offline');
  }

  private setStatus(s: NetStatus, detail?: string): void {
    this.status = s;
    this.handlers.onStatus(s, detail);
  }

  private onTransportStatus(s: TransportStatus, detail?: string): void {
    if (s === 'connecting') {
      this.setStatus('connecting');
    } else if (s === 'joined') {
      this.setStatus('online');
      this.transport?.track({ ...this.meta });
      if (!this.welcomed) {
        this.welcomed = true;
        this.handlers.onWelcome({
          id: this.selfId,
          room: this.room,
          seed: hashString(this.room),
          state: this.roomState(),
        });
      }
    } else if (s === 'error') {
      this.setStatus('error', detail);
    } else if (s === 'closed') {
      if (this.transport) this.setStatus('offline');
    }
  }

  // -------------------------------------------------------------- presence

  private onPresence(p: PresenceMap): void {
    this.presence = p;
    // Make sure our own metadata is represented even before the first sync round-trips.
    if (!p[this.selfId]) p[this.selfId] = { ...this.meta };

    const host = this.electHost();
    const becameHost = host === this.selfId && this.lastHost !== this.selfId;
    const members = Object.keys(p);
    const newMember = members.some((k) => !this.knownMembers.has(k));
    this.knownMembers = new Set(members);
    this.lastHost = host;

    if (host === this.selfId) {
      // Assert authority to any newcomers, then check whether the hole is complete.
      if (becameHost || newMember) this.broadcastState();
      this.checkAdvance();
    }

    this.emitState();
  }

  private onMessage(event: string, payload: unknown): void {
    switch (event) {
      case 'state': {
        const s = payload as StatePayload;
        // Accept room state only from the elected host, and never override our own.
        if (this.amHost || s.by !== this.electHost()) return;
        this.applyRoomMeta({ phase: s.phase, hole: s.hole, config: s.config });
        break;
      }
      case 'pos': {
        const s = payload as PosPayload;
        if (s.id !== this.selfId) this.handlers.onPos(s.id, s.x, s.y, s.state);
        break;
      }
      case 'kick': {
        const s = payload as KickPayload;
        if (s.id === this.selfId) {
          this.handlers.onKicked('The host removed you from the room.');
          this.disconnect();
        }
        break;
      }
      case 'countdown': {
        this.handlers.onCountdown((payload as CountdownPayload).seconds);
        break;
      }
    }
  }

  /** Earliest joiner wins; ties broken by id so every client agrees. */
  private electHost(): string {
    let bestKey = '';
    let bestAt = Infinity;
    for (const [key, raw] of Object.entries(this.presence)) {
      const at = Number(asMeta(raw).joinedAt ?? Infinity);
      if (bestKey === '' || at < bestAt || (at === bestAt && key < bestKey)) {
        bestAt = at;
        bestKey = key;
      }
    }
    return bestKey;
  }

  private players(): PlayerInfo[] {
    const list = Object.values(this.presence).map((m) => {
      const meta = asMeta(m);
      return {
        id: meta.id,
        name: meta.name,
        hue: meta.hue,
        strokes: meta.strokes ?? 0,
        total: meta.total ?? 0,
        state: meta.state ?? 'idle',
        done: Boolean(meta.done),
      };
    });
    // Stable order: join time, then id.
    list.sort((a, b) => {
      const am = asMeta(this.presence[a.id]);
      const bm = asMeta(this.presence[b.id]);
      return (am?.joinedAt ?? 0) - (bm?.joinedAt ?? 0) || a.id.localeCompare(b.id);
    });
    return list;
  }

  private roomState(): RoomState {
    return {
      phase: this.roomMeta.phase,
      hole: this.roomMeta.hole,
      host: this.electHost(),
      config: this.roomMeta.config,
      players: this.players(),
    };
  }

  private emitState(): void {
    this.handlers.onState(this.roomState());
  }

  // ------------------------------------------------------- room-state authority

  private broadcastState(): void {
    const payload: StatePayload = {
      by: this.selfId,
      phase: this.roomMeta.phase,
      hole: this.roomMeta.hole,
      config: this.roomMeta.config,
    };
    this.transport?.broadcast('state', payload);
  }

  /** Applies a new room meta locally, resetting our own score across transitions. */
  private applyRoomMeta(next: RoomMeta): void {
    const prev = this.roomMeta;
    const phaseChanged = next.phase !== prev.phase;
    const holeChanged = next.hole !== prev.hole;
    this.roomMeta = next;

    if (phaseChanged) {
      // A fresh game (or return to lobby) zeroes the whole card.
      this.meta.total = 0;
      this.meta.strokes = 0;
      this.meta.done = false;
      this.meta.state = 'idle';
      this.trackMeta();
    } else if (holeChanged) {
      // Bank the finished hole, then reset for the next.
      this.meta.total += this.meta.strokes;
      this.meta.strokes = 0;
      this.meta.done = false;
      this.meta.state = 'idle';
      this.trackMeta();
    }

    this.emitState();
  }

  /** Host-authored change: apply locally and tell everyone. */
  private commitRoomMeta(next: RoomMeta): void {
    this.applyRoomMeta(next);
    this.broadcastState();
  }

  private checkAdvance(): void {
    if (this.roomMeta.phase !== 'playing' || this.advanceTimer) return;
    const players = this.players();
    if (players.length === 0 || !players.every((p) => p.done)) return;

    this.transport?.broadcast('countdown', { seconds: Math.round(advanceDelayMs / 1000) } satisfies CountdownPayload);
    this.handlers.onCountdown(Math.round(advanceDelayMs / 1000));
    this.advanceTimer = setTimeout(() => {
      this.advanceTimer = null;
      if (!this.amHost) return;
      this.commitRoomMeta({ ...this.roomMeta, hole: this.roomMeta.hole + 1 });
    }, advanceDelayMs);
  }

  private trackMeta(): void {
    this.transport?.track({ ...this.meta });
  }

  // ------------------------------------------------------------- host actions

  start(): void {
    if (!this.amHost) return;
    this.commitRoomMeta({ phase: 'playing', hole: 1, config: this.roomMeta.config });
  }

  toLobby(): void {
    if (!this.amHost) return;
    this.commitRoomMeta({ phase: 'lobby', hole: this.roomMeta.hole, config: this.roomMeta.config });
  }

  setConfig(partial: Partial<RoomConfig>): void {
    if (!this.amHost) return;
    this.commitRoomMeta({ ...this.roomMeta, config: { ...this.roomMeta.config, ...partial } });
  }

  kick(id: string): void {
    if (!this.amHost || id === this.selfId) return;
    this.transport?.broadcast('kick', { id } satisfies KickPayload);
  }

  // ---------------------------------------------------------- per-player score

  markStrokes(n: number): void {
    this.meta.strokes = Math.max(0, Math.min(999, n | 0));
    this.meta.state = 'flying';
    this.trackMeta();
  }

  markReady(): void {
    this.meta.done = true;
    this.trackMeta();
    if (this.amHost) this.checkAdvance();
  }

  markDone(n: number, result: 'sunk' | 'lost'): void {
    this.meta.strokes = Math.max(0, Math.min(999, n | 0));
    this.meta.state = result === 'sunk' ? 'sunk' : 'lost';
    this.meta.done = true;
    this.trackMeta();
    if (this.amHost) this.checkAdvance();
  }

  /** Throttled position broadcast — ghosts only need ~20 Hz. */
  sendPos(x: number, y: number, state: string, now: number): void {
    if (!this.connected || now - this.lastPosSent < 50) return;
    this.lastPosSent = now;
    this.transport?.broadcast('pos', { id: this.selfId, x, y, state } satisfies PosPayload);
  }
}

function asMeta(x: unknown): PresenceMeta {
  return x as unknown as PresenceMeta;
}

function blankMeta(): PresenceMeta {
  return { id: '', name: '', hue: 200, strokes: 0, total: 0, state: 'idle', done: false, joinedAt: 0 };
}

function randomId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `p${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}
