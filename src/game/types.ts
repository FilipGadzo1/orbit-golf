import type { Vec } from '../core/vec';

export type BodyKind = 'rock' | 'ice' | 'lava' | 'gas' | 'blackhole' | 'repulsor';

export interface Orbit {
  /** Centre the body revolves around. */
  cx: number;
  cy: number;
  radius: number;
  /** Radians per second. */
  speed: number;
  phase: number;
}

export interface Body {
  id: number;
  kind: BodyKind;
  pos: Vec;
  radius: number;
  /** Gravitational mass. Negative for repulsors. */
  mass: number;
  /** 0 = perfectly slippery, 1 = sticky. Applied to tangential velocity on impact. */
  friction: number;
  /** Bounciness of the surface normal response. */
  restitution: number;
  hue: number;
  /** Present when the body moves along a circular path. */
  orbit?: Orbit;
  /** Cosmetic surface detail, generated once. */
  craters: { a: number; d: number; r: number }[];
  ring?: { tilt: number; inner: number; outer: number };
  /** Body kills the ball on contact (black holes, stars). */
  lethal: boolean;
}

export interface Level {
  seed: number;
  index: number;
  bodies: Body[];
  startBody: number;
  startAngle: number;
  holeBody: number;
  holeAngle: number;
  par: number;
  worldRadius: number;
  tier: DifficultyTier;
}

export type DifficultyTier = 'Easy' | 'Medium' | 'Hard' | 'Extreme';

export interface Ball {
  pos: Vec;
  vel: Vec;
  radius: number;
  /** Idle = waiting for a shot, flying = in motion, sunk/lost = terminal for this hole. */
  state: 'idle' | 'flying' | 'sunk' | 'lost';
  /** Body the ball is currently resting on, or -1. */
  restingOn: number;
  /** Angle on that body's surface, so the ball rides along with orbiting planets. */
  restAngle: number;
  trail: Vec[];
}
