export interface PlayerInfo {
  id: string;
  name: string;
  hue: number;
  strokes: number;
  total: number;
  state: 'idle' | 'flying' | 'sunk' | 'lost';
  done: boolean;
}

export type ClientMsg =
  | { t: 'join'; room: string; name: string; hue: number; seed?: number }
  | { t: 'pos'; x: number; y: number; state: string }
  | { t: 'stroke'; strokes: number }
  | { t: 'done'; strokes: number; result: 'sunk' | 'lost' }
  | { t: 'ready' }
  | { t: 'ping' };

export type ServerMsg =
  | { t: 'welcome'; id: string; room: string; seed: number; hole: number; players: PlayerInfo[] }
  | { t: 'players'; players: PlayerInfo[] }
  | { t: 'pos'; id: string; x: number; y: number; state: string }
  | { t: 'hole'; hole: number; players: PlayerInfo[] }
  | { t: 'countdown'; seconds: number }
  | { t: 'error'; message: string }
  | { t: 'pong' };
