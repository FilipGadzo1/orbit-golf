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

/** Everything the game needs to render room-level state. */
export interface RoomState {
  phase: RoomPhase;
  hole: number;
  host: string;
  config: RoomConfig;
  players: PlayerInfo[];
}

// -------------------------------------------------------- realtime payloads

/**
 * Per-player Presence metadata. Presence handles join/leave and carries each player's
 * low-frequency score state; live ball positions travel over Broadcast instead.
 */
export interface PresenceMeta {
  id: string;
  name: string;
  hue: number;
  strokes: number;
  total: number;
  state: PlayerInfo['state'];
  done: boolean;
  /** Client wall-clock at join, used for deterministic host election. */
  joinedAt: number;
}

/** The host-authored slice of room state, broadcast on every change. */
export interface RoomMeta {
  phase: RoomPhase;
  hole: number;
  config: RoomConfig;
}

/** Broadcast event names on the room channel. */
export type BroadcastEvent = 'state' | 'pos' | 'kick' | 'countdown';

export interface StatePayload extends RoomMeta {
  /** Sender id; receivers accept state only from the currently-elected host. */
  by: string;
}
export interface PosPayload {
  id: string;
  x: number;
  y: number;
  state: string;
}
export interface KickPayload {
  id: string;
}
export interface CountdownPayload {
  seconds: number;
}
