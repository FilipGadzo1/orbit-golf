/**
 * A tiny transport abstraction over "a room you can join, announce your presence in, and
 * broadcast ephemeral messages to". The production implementation is Supabase Realtime;
 * an in-memory implementation lets the whole multiplayer stack be tested in one process
 * with no network or browser.
 */
export type TransportStatus = 'connecting' | 'joined' | 'error' | 'closed';

export type PresenceMap = Record<string, Record<string, unknown>>;

export interface Transport {
  /** Stable per-connection key; also used as the player id. */
  readonly selfKey: string;
  onStatus(cb: (status: TransportStatus, detail?: string) => void): void;
  onPresence(cb: (presence: PresenceMap) => void): void;
  onMessage(cb: (event: string, payload: unknown) => void): void;
  /** Joins the room and begins receiving presence/messages. */
  subscribe(): void;
  /** Publishes/updates this client's presence metadata. */
  track(meta: Record<string, unknown>): void;
  /** Fire-and-forget broadcast to everyone else in the room. */
  broadcast(event: string, payload: unknown): void;
  close(): void;
}

export type TransportFactory = (room: string, selfKey: string) => Transport;

// ---------------------------------------------------------------- Supabase

import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_KEY, SUPABASE_URL } from './config';

let sharedClient: SupabaseClient | null = null;
function client(): SupabaseClient {
  if (!sharedClient) {
    sharedClient = createClient(SUPABASE_URL, SUPABASE_KEY, {
      realtime: { params: { eventsPerSecond: 25 } },
    });
  }
  return sharedClient;
}

class SupabaseTransport implements Transport {
  private channel: RealtimeChannel;
  private statusCb: (s: TransportStatus, detail?: string) => void = () => {};
  private presenceCb: (p: PresenceMap) => void = () => {};
  private messageCb: (event: string, payload: unknown) => void = () => {};

  constructor(
    room: string,
    readonly selfKey: string,
  ) {
    this.channel = client().channel(`orbit:${room}`, {
      config: {
        presence: { key: selfKey },
        broadcast: { self: false },
      },
    });
  }

  onStatus(cb: (s: TransportStatus, detail?: string) => void): void {
    this.statusCb = cb;
  }
  onPresence(cb: (p: PresenceMap) => void): void {
    this.presenceCb = cb;
  }
  onMessage(cb: (event: string, payload: unknown) => void): void {
    this.messageCb = cb;
  }

  private flatten(): PresenceMap {
    const state = this.channel.presenceState<Record<string, unknown>>();
    const out: PresenceMap = {};
    for (const [key, metas] of Object.entries(state)) {
      if (metas && metas.length) out[key] = metas[0];
    }
    return out;
  }

  subscribe(): void {
    this.statusCb('connecting');
    this.channel.on('presence', { event: 'sync' }, () => this.presenceCb(this.flatten()));
    // A single catch-all broadcast listener; the app multiplexes on the event name.
    this.channel.on('broadcast', { event: '*' }, (msg) => {
      this.messageCb(String(msg.event), msg.payload);
    });
    this.channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') this.statusCb('joined');
      else if (status === 'CHANNEL_ERROR') this.statusCb('error', 'Realtime channel error.');
      else if (status === 'TIMED_OUT') this.statusCb('error', 'Timed out reaching Supabase Realtime.');
      else if (status === 'CLOSED') this.statusCb('closed');
    });
  }

  track(meta: Record<string, unknown>): void {
    void this.channel.track(meta);
  }

  broadcast(event: string, payload: unknown): void {
    void this.channel.send({ type: 'broadcast', event, payload });
  }

  close(): void {
    void client().removeChannel(this.channel);
  }
}

export const supabaseTransportFactory: TransportFactory = (room, selfKey) =>
  new SupabaseTransport(room, selfKey);

// ------------------------------------------------------------- in-memory

/**
 * Process-local relay used by tests (and the browser smoke test) to run several clients
 * against each other with no network. Mirrors Supabase semantics: presence is a shared
 * map keyed by selfKey, broadcasts fan out to everyone except the sender.
 */
class Relay {
  members = new Set<InMemoryTransport>();
  presence: PresenceMap = {};

  join(t: InMemoryTransport): void {
    this.members.add(t);
    this.syncAll();
  }

  leave(t: InMemoryTransport): void {
    this.members.delete(t);
    delete this.presence[t.selfKey];
    this.syncAll();
  }

  track(key: string, meta: Record<string, unknown>): void {
    this.presence[key] = meta;
    this.syncAll();
  }

  broadcast(from: InMemoryTransport, event: string, payload: unknown): void {
    for (const m of this.members) {
      if (m !== from) m.deliver(event, payload);
    }
  }

  private syncAll(): void {
    const snapshot = { ...this.presence };
    for (const m of this.members) m.syncPresence(snapshot);
  }
}

const relays = new Map<string, Relay>();
function relayFor(room: string): Relay {
  let r = relays.get(room);
  if (!r) {
    r = new Relay();
    relays.set(room, r);
  }
  return r;
}

/** Clears all in-memory rooms — handy between test cases. */
export function resetMemoryRelays(): void {
  relays.clear();
}

class InMemoryTransport implements Transport {
  private relay: Relay;
  private statusCb: (s: TransportStatus, detail?: string) => void = () => {};
  private presenceCb: (p: PresenceMap) => void = () => {};
  private messageCb: (event: string, payload: unknown) => void = () => {};
  private open = false;

  constructor(room: string, readonly selfKey: string) {
    this.relay = relayFor(room);
  }

  onStatus(cb: (s: TransportStatus, detail?: string) => void): void {
    this.statusCb = cb;
  }
  onPresence(cb: (p: PresenceMap) => void): void {
    this.presenceCb = cb;
  }
  onMessage(cb: (event: string, payload: unknown) => void): void {
    this.messageCb = cb;
  }

  subscribe(): void {
    this.statusCb('connecting');
    this.open = true;
    // Async to mirror the network round-trip and let callers attach handlers first.
    queueMicrotask(() => {
      if (!this.open) return;
      this.relay.join(this);
      this.statusCb('joined');
    });
  }

  track(meta: Record<string, unknown>): void {
    if (this.open) this.relay.track(this.selfKey, meta);
  }

  broadcast(event: string, payload: unknown): void {
    if (this.open) this.relay.broadcast(this, event, payload);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.relay.leave(this);
    this.statusCb('closed');
  }

  // Called by the relay:
  syncPresence(p: PresenceMap): void {
    if (this.open) this.presenceCb(p);
  }
  deliver(event: string, payload: unknown): void {
    if (this.open) this.messageCb(event, payload);
  }
}

export const memoryTransportFactory: TransportFactory = (room, selfKey) =>
  new InMemoryTransport(room, selfKey);
