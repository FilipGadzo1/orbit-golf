import { hashString } from '../core/rng';
import { isMultiplayerConfigured } from './config';
import {
  DEFAULT_ROOM_CONFIG,
  type KickPayload,
  type PlayerInfo,
  type PosPayload,
  type PresenceMeta,
  type ReadyPayload,
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
  onKicked: (reason: string) => void;
  onStatus: (status: NetStatus, detail?: string) => void;
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

  /** Ids that have signalled "finished" for the current hole, via broadcast. */
  private readyIds = new Set<string>();
  private welcomed = false;
  private lastPosSent = 0;
  private lastPosState = '';

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

  connect(room: string, name: string, hue: number, skin = 'classic'): void {
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
    this.readyIds.clear();
    this.lastPosState = '';
    this.roomMeta = { phase: 'lobby', hole: 1, config: { ...DEFAULT_ROOM_CONFIG } };
    this.meta = { ...blankMeta(), id: this.selfId, name: name.slice(0, 18) || 'Player', hue, skin, joinedAt: Date.now() };

    this.setStatus('connecting');
    const t = this.factory(code, this.selfId);
    this.transport = t;
    t.onStatus((s, detail) => this.onTransportStatus(s, detail));
    t.onPresence((p) => this.onPresence(p));
    t.onMessage((event, payload) => this.onMessage(event, payload));
    t.subscribe();
  }

  disconnect(): void {
    if (this.transport) {
      const t = this.transport;
      this.transport = null;
      t.close();
    }
    this.selfId = '';
    this.room = '';
    this.presence = {};
    this.readyIds.clear();
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
    if (this.electHost() === this.selfId) {
      // Re-assert room state on every roster/score change (cheap; makes the room
      // self-healing) and refresh the local view so the host's Next button reflects
      // current readiness.
      this.broadcastState();
      this.emitState();
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
      case 'ready': {
        const s = payload as ReadyPayload;
        // Ignore stale readys from a previous hole.
        if (s.hole === this.roomMeta.hole) this.noteReady(s.id);
        break;
      }
    }
  }

  /**
   * Presence with our own live metadata overlaid. The Presence echo of ourselves can lag a
   * track(), and can even be transiently absent during a resync — trusting that could make
   * the host miss its own state or mis-elect a host. Everything that reasons about the
   * roster or the host goes through this so our own view is always current.
   */
  private mergedPresence(): PresenceMap {
    const merged: PresenceMap = { ...this.presence };
    if (this.selfId) merged[this.selfId] = { ...this.meta } as unknown as Record<string, unknown>;
    return merged;
  }

  /** Earliest joiner wins; ties broken by id so every client agrees. */
  private electHost(): string {
    let bestKey = '';
    let bestAt = Infinity;
    for (const [key, raw] of Object.entries(this.mergedPresence())) {
      const at = Number(asMeta(raw).joinedAt ?? Infinity);
      if (bestKey === '' || at < bestAt || (at === bestAt && key < bestKey)) {
        bestAt = at;
        bestKey = key;
      }
    }
    return bestKey;
  }

  /**
   * True when a player has finished the *current* hole. A `done` flag is only trusted when
   * its `doneHole` matches — otherwise a stale flag from the previous hole would let the
   * room skip ahead. `readyIds` is the fast per-hole broadcast signal; `doneHole` is the
   * durable Presence fallback that also survives host handoff.
   */
  private isReady(id: string, meta: PresenceMeta): boolean {
    return this.readyIds.has(id) || Number(meta.doneHole) === this.roomMeta.hole;
  }

  private players(): PlayerInfo[] {
    const merged = this.mergedPresence();
    const list = Object.entries(merged).map(([id, m]) => {
      const meta = asMeta(m);
      return {
        id: meta.id || id,
        name: meta.name,
        hue: meta.hue,
        strokes: meta.strokes ?? 0,
        total: meta.total ?? 0,
        state: meta.state ?? 'idle',
        skin: meta.skin ?? 'classic',
        // "Done" for display means ready for the current hole, not some earlier one.
        done: this.isReady(id, meta),
      };
    });
    // Stable order: join time, then id.
    list.sort((a, b) => {
      const am = asMeta(merged[a.id]);
      const bm = asMeta(merged[b.id]);
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

    // Each new hole (or phase change) starts the finished-set fresh.
    if (phaseChanged || holeChanged) this.readyIds.clear();

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

  /** Records that a player readied for the current hole and refreshes the host's view. */
  private noteReady(id: string): void {
    this.readyIds.add(id);
    if (this.amHost) this.emitState();
  }

  /** True when every player currently in the room is ready for the current hole. */
  private everyoneReady(): boolean {
    const merged = this.mergedPresence();
    const ids = Object.keys(merged);
    if (ids.length === 0) return false;
    return ids.every((id) => this.isReady(id, asMeta(merged[id])));
  }

  private trackMeta(): void {
    this.transport?.track({ ...this.meta });
  }

  // ------------------------------------------------------------- host actions

  start(): void {
    if (!this.amHost) return;
    this.commitRoomMeta({ phase: 'playing', hole: 1, config: this.roomMeta.config });
  }

  /** Host-only, manual, gated: advance to the next hole only when everyone is ready. */
  advanceHole(): void {
    if (!this.amHost || this.roomMeta.phase !== 'playing') return;
    if (!this.everyoneReady()) return;
    this.commitRoomMeta({ ...this.roomMeta, hole: this.roomMeta.hole + 1 });
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
    this.meta.doneHole = this.roomMeta.hole;
    this.trackMeta();
    this.announceReady();
  }

  /** Records the player's finished-hole score without marking them ready. */
  markScore(n: number, result: 'sunk' | 'lost'): void {
    this.meta.strokes = Math.max(0, Math.min(999, n | 0));
    this.meta.state = result === 'sunk' ? 'sunk' : 'lost';
    this.trackMeta();
  }

  /** Tell the room we've finished this hole via the fast broadcast path, and note it locally. */
  private announceReady(): void {
    this.transport?.broadcast('ready', { id: this.selfId, hole: this.roomMeta.hole } satisfies ReadyPayload);
    this.noteReady(this.selfId);
  }

  /**
   * Position broadcast for ghosts. While the ball is flying it streams at ~20 Hz; when
   * the ball is at rest (idle/sunk/lost) it sends a single update on the state change and
   * then goes quiet.
   *
   * This matters a lot: the game loop calls this every frame for everyone, including
   * players sitting on the result screen. If finished players kept streaming ~20 Hz, they
   * would saturate the channel's per-client rate budget and starve the Presence `track()`
   * that carries each player's `done` flag — so the host would never see everyone finish
   * and the room would hang on "waiting for other players".
   */
  sendPos(x: number, y: number, state: string, now: number): void {
    if (!this.connected) return;
    const changed = state !== this.lastPosState;
    // At rest: only send when the state changes. Flying: throttle to 20 Hz.
    if (!changed && state !== 'flying') return;
    if (!changed && now - this.lastPosSent < 50) return;
    this.lastPosState = state;
    this.lastPosSent = now;
    this.transport?.broadcast('pos', { id: this.selfId, x, y, state } satisfies PosPayload);
  }

  /**
   * Broadcast the equipped cosmetic skin. A static, low-frequency Presence field: it updates
   * local meta and re-tracks so the change propagates immediately. It never touches
   * election/advancement, RoomMeta, or the `pos` hot path.
   */
  setSkin(id: string): void {
    this.meta.skin = id;
    this.transport?.track({ ...this.meta });
  }
}

function asMeta(x: unknown): PresenceMeta {
  return x as unknown as PresenceMeta;
}

function blankMeta(): PresenceMeta {
  return { id: '', name: '', hue: 200, strokes: 0, total: 0, state: 'idle', done: false, doneHole: 0, joinedAt: 0, skin: 'classic' };
}

function randomId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `p${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}
