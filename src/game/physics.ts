import type { Vec } from '../core/vec';
import { G, surfacePoint, updateBodies } from './generator';
import type { Ball, Body, Level } from './types';

export const BALL_RADIUS = 7;
/** Below this speed while touching a surface the ball is considered parked. */
const REST_SPEED = 34;
/** How long the ball must stay slow and in contact before the shot ends. */
const REST_TIME = 0.22;
/** A normal-velocity impact above this is a real bounce, below it is resting contact. */
const BOUNCE_THRESHOLD = 40;
export const MAX_SHOT_SPEED = 900;

export interface ImpactEvent {
  kind: 'bounce' | 'sink' | 'lost' | 'crush' | 'stop' | 'adrift';
  pos: Vec;
  strength: number;
  bodyId?: number;
}

export interface StepResult {
  events: ImpactEvent[];
}

/** Net gravitational acceleration at a point, ignoring the ball's own mass. */
export function gravityAt(bodies: Body[], x: number, y: number, out: Vec = { x: 0, y: 0 }): Vec {
  out.x = 0;
  out.y = 0;
  for (const b of bodies) {
    const dx = b.pos.x - x;
    const dy = b.pos.y - y;
    // Soften inside the body radius so the field never blows up numerically.
    const soft = b.radius * 0.75;
    const d2 = Math.max(dx * dx + dy * dy, soft * soft);
    const d = Math.sqrt(d2);
    const a = (G * b.mass) / d2;
    out.x += (dx / d) * a;
    out.y += (dy / d) * a;
  }
  return out;
}

function reflect(ball: Ball, body: Body, nx: number, ny: number, dt: number): number {
  const vn = ball.vel.x * nx + ball.vel.y * ny;
  const tx = ball.vel.x - vn * nx;
  const ty = ball.vel.y - vn * ny;
  const impact = Math.abs(vn);

  // A hard hit loses tangential speed as a single impulse; a ball merely resting on the
  // surface is drained over time instead, otherwise per-substep contacts would kill all
  // rolling within a few milliseconds.
  const keep =
    impact > BOUNCE_THRESHOLD
      ? 1 - body.friction * 0.28
      : Math.exp(-body.friction * 2.6 * dt);

  ball.vel.x = tx * keep - vn * body.restitution * nx;
  ball.vel.y = ty * keep - vn * body.restitution * ny;
  return impact;
}

export interface SimState {
  /** Seconds spent slow and in contact; resets whenever the ball breaks away. */
  restTime: number;
  /** Seconds since the ball last touched any surface. Resets to 0 on every contact. */
  contactAge: number;
}

const scratch: Vec = { x: 0, y: 0 };

/**
 * Advances the ball by one fixed sub-step. Bodies must already be positioned for `time`.
 * Returns events worth reacting to (sound, particles, scoring).
 */
export function stepBall(
  ball: Ball,
  level: Level,
  dt: number,
  sim: SimState,
  events: ImpactEvent[],
): void {
  if (ball.state !== 'flying') return;

  gravityAt(level.bodies, ball.pos.x, ball.pos.y, scratch);
  ball.vel.x += scratch.x * dt;
  ball.vel.y += scratch.y * dt;
  ball.pos.x += ball.vel.x * dt;
  ball.pos.y += ball.vel.y * dt;

  const hole = level.bodies[level.holeBody];
  const holePos = surfacePoint(hole, level.holeAngle, -2);

  let touching = false;
  for (const body of level.bodies) {
    const dx = ball.pos.x - body.pos.x;
    const dy = ball.pos.y - body.pos.y;
    const d = Math.hypot(dx, dy) || 1e-6;
    const minDist = body.radius + ball.radius;
    if (d >= minDist) continue;

    if (body.lethal) {
      ball.state = 'lost';
      events.push({ kind: 'crush', pos: { ...ball.pos }, strength: 1, bodyId: body.id });
      return;
    }

    touching = true;
    const nx = dx / d;
    const ny = dy / d;
    // Depenetrate before responding so repeated contacts don't accumulate error.
    ball.pos.x = body.pos.x + nx * minDist;
    ball.pos.y = body.pos.y + ny * minDist;
    const impact = reflect(ball, body, nx, ny, dt);

    if (impact > BOUNCE_THRESHOLD) {
      events.push({ kind: 'bounce', pos: { ...ball.pos }, strength: Math.min(1, impact / 500), bodyId: body.id });
    }

    const speed = Math.hypot(ball.vel.x, ball.vel.y);
    if (speed < REST_SPEED) {
      sim.restTime += dt;
      if (sim.restTime > REST_TIME) {
        ball.state = 'idle';
        ball.vel.x = 0;
        ball.vel.y = 0;
        ball.restingOn = body.id;
        ball.restAngle = Math.atan2(ny, nx);
        events.push({ kind: 'stop', pos: { ...ball.pos }, strength: 0 });
        return;
      }
    } else {
      sim.restTime = 0;
    }
  }

  // Losing contact for more than a moment means the ball is airborne again.
  if (touching) {
    sim.contactAge = 0;
  } else {
    sim.contactAge += dt;
    if (sim.contactAge > 0.12) sim.restTime = 0;
  }

  // Cup capture: close enough and slow enough to drop in.
  const hd = Math.hypot(ball.pos.x - holePos.x, ball.pos.y - holePos.y);
  const speed = Math.hypot(ball.vel.x, ball.vel.y);
  if (hd < 16 && speed < 340) {
    ball.state = 'sunk';
    ball.pos.x = holePos.x;
    ball.pos.y = holePos.y;
    ball.vel.x = 0;
    ball.vel.y = 0;
    events.push({ kind: 'sink', pos: { ...holePos }, strength: 1 });
    return;
  }

  if (Math.hypot(ball.pos.x, ball.pos.y) > level.worldRadius) {
    ball.state = 'lost';
    events.push({ kind: 'lost', pos: { ...ball.pos }, strength: 1 });
  }
}

export function makeSim(): SimState {
  return { restTime: 0, contactAge: 0 };
}

/**
 * Runs a throwaway simulation from the current ball position to draw the aim guide.
 * `maxSeconds` is what the aim-assist setting controls.
 */
export function predictTrajectory(
  level: Level,
  origin: Vec,
  velocity: Vec,
  maxSeconds: number,
  startTime: number,
): { points: Vec[]; outcome: 'open' | 'sunk' | 'lost' | 'crush' | 'stop' } {
  const ghost: Ball = {
    pos: { x: origin.x, y: origin.y },
    vel: { x: velocity.x, y: velocity.y },
    radius: BALL_RADIUS,
    state: 'flying',
    restingOn: -1,
    restAngle: 0,
    trail: [],
  };
  const dt = 1 / 120;
  const steps = Math.floor(maxSeconds / dt);
  const points: Vec[] = [];
  const sim = makeSim();
  const events: ImpactEvent[] = [];
  // Snapshot orbiting body positions so the preview doesn't permanently move them.
  const saved = level.bodies.map((b) => ({ x: b.pos.x, y: b.pos.y }));

  let outcome: 'open' | 'sunk' | 'lost' | 'crush' | 'stop' = 'open';
  for (let i = 0; i < steps; i++) {
    updateBodies(level, startTime + i * dt);
    stepBall(ghost, level, dt, sim, events);
    if (i % 4 === 0) points.push({ x: ghost.pos.x, y: ghost.pos.y });
    if (ghost.state !== 'flying') {
      points.push({ x: ghost.pos.x, y: ghost.pos.y });
      outcome =
        ghost.state === 'sunk'
          ? 'sunk'
          : ghost.state === 'lost'
            ? events.some((e) => e.kind === 'crush')
              ? 'crush'
              : 'lost'
            : 'stop';
      break;
    }
  }

  for (let i = 0; i < level.bodies.length; i++) {
    level.bodies[i].pos.x = saved[i].x;
    level.bodies[i].pos.y = saved[i].y;
  }
  return { points, outcome };
}
