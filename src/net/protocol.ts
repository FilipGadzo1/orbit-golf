export interface PlayerInfo {
  id: string;
  name: string;
  hue: number;
  strokes: number;
  total: number;
  state: 'idle' | 'flying' | 'sunk' | 'lost';
  done: boolean;
}

/** How the aim guide is governed for a room. Set by the host. */
export type AimPolicy = 'free' | 'on' | 'off';

export interface RoomConfig {
  /** free = each player's own setting, on = forced for all, off = disabled for all. */
  aimPolicy: AimPolicy;
  /** When false, retrying a hole is blocked for everyone. */
  allowRestart: boolean;
}

export const DEFAULT_ROOM_CONFIG: RoomConfig = {
  aimPolicy: 'free',
  allowRestart: true,
};

/** Rooms sit in a waiting lobby until the host starts the game. */
export type RoomPhase = 'lobby' | 'playing';

/** Everything a client needs to render room-level state, sent on any change. */
export interface RoomState {
  phase: RoomPhase;
  hole: number;
  host: string;
  config: RoomConfig;
  players: PlayerInfo[];
}

export type ClientMsg =
  | { t: 'join'; room: string; name: string; hue: number; seed?: number }
  | { t: 'pos'; x: number; y: number; state: string }
  | { t: 'stroke'; strokes: number }
  | { t: 'done'; strokes: number; result: 'sunk' | 'lost' }
  | { t: 'ready' }
  // Host-only actions — the server ignores them from non-hosts.
  | { t: 'start' }
  | { t: 'kick'; id: string }
  | { t: 'config'; config: Partial<RoomConfig> }
  | { t: 'lobby' }
  | { t: 'ping' };

export type ServerMsg =
  | { t: 'welcome'; id: string; room: string; seed: number; state: RoomState }
  | { t: 'state'; state: RoomState }
  | { t: 'pos'; id: string; x: number; y: number; state: string }
  | { t: 'countdown'; seconds: number }
  | { t: 'kicked'; reason: string }
  | { t: 'error'; message: string }
  | { t: 'pong' };
