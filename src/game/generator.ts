import { Rng } from '../core/rng';
import { dist } from '../core/vec';
import type { Body, BodyKind, DifficultyTier, Level } from './types';

/**
 * Gravitational constant tuned for the game's unit scale (1 unit ≈ 1 px at zoom 1).
 * Mass is `density * radius²`, so surface gravity works out to exactly `G * density` —
 * independent of planet size. Big planets therefore feel the same underfoot but have
 * a far deeper well to escape, which is what makes size read as difficulty.
 */
export const G = 560;

export function tierFor(index: number): DifficultyTier {
  if (index <= 5) return 'Easy';
  if (index <= 12) return 'Medium';
  if (index <= 22) return 'Hard';
  return 'Extreme';
}

interface TierSpec {
  planets: [number, number];
  spread: number;
  movers: number;
  blackHoles: number;
  repulsors: number;
  radius: [number, number];
}

function specFor(index: number, tier: DifficultyTier): TierSpec {
  // `t` ramps 0 -> 1 across the first 30 holes and keeps creeping after that.
  const t = Math.min(1, (index - 1) / 29);
  const base: TierSpec = {
    planets: [2, 3],
    spread: 1300,
    movers: 0,
    blackHoles: 0,
    repulsors: 0,
    radius: [70, 130],
  };
  switch (tier) {
    case 'Easy':
      base.planets = [2, 3];
      base.spread = 1200 + t * 400;
      base.radius = [80, 140];
      break;
    case 'Medium':
      base.planets = [3, 5];
      base.spread = 1700 + t * 700;
      base.movers = index % 3 === 0 ? 1 : 0;
      base.radius = [60, 130];
      break;
    case 'Hard':
      base.planets = [5, 7];
      base.spread = 2400 + t * 900;
      base.movers = 1 + (index % 2);
      base.blackHoles = index % 4 === 0 ? 1 : 0;
      base.repulsors = index % 5 === 0 ? 1 : 0;
      base.radius = [45, 120];
      break;
    case 'Extreme':
      base.planets = [7, 10];
      base.spread = 3200 + t * 1400;
      base.movers = 2 + (index % 3);
      base.blackHoles = 1;
      base.repulsors = 1 + (index % 2);
      base.radius = [35, 110];
      break;
  }
  return base;
}

const HUES: Record<BodyKind, [number, number]> = {
  rock: [18, 42],
  ice: [180, 210],
  lava: [0, 24],
  gas: [265, 320],
  blackhole: [255, 275],
  repulsor: [140, 165],
};

const SURFACE: Record<BodyKind, { friction: number; restitution: number; density: number }> = {
  rock: { friction: 0.42, restitution: 0.38, density: 1.0 },
  ice: { friction: 0.06, restitution: 0.72, density: 0.85 },
  lava: { friction: 0.62, restitution: 0.18, density: 1.25 },
  gas: { friction: 0.78, restitution: 0.05, density: 0.55 },
  blackhole: { friction: 1, restitution: 0, density: 14 },
  repulsor: { friction: 0.3, restitution: 0.85, density: -1.6 },
};

function makeBody(rng: Rng, id: number, kind: BodyKind, x: number, y: number, radius: number): Body {
  const surf = SURFACE[kind];
  const [h0, h1] = HUES[kind];
  const craters = [];
  const craterCount = kind === 'gas' || kind === 'blackhole' ? 0 : rng.int(3, 7);
  for (let i = 0; i < craterCount; i++) {
    craters.push({ a: rng.angle(), d: rng.range(0.15, 0.82), r: rng.range(0.06, 0.19) });
  }
  const body: Body = {
    id,
    kind,
    pos: { x, y },
    radius,
    // Mass scales with area so big planets have proportionally deeper wells.
    mass: surf.density * radius * radius,
    friction: surf.friction,
    restitution: surf.restitution,
    hue: rng.range(h0, h1),
    craters,
    lethal: kind === 'blackhole',
  };
  if (kind === 'gas' && rng.chance(0.45)) {
    body.ring = { tilt: rng.range(-0.5, 0.5), inner: 1.4, outer: rng.range(1.8, 2.3) };
  }
  return body;
}

/** Rejection-sample body centres so no two surfaces overlap or crowd each other. */
function placeBodies(rng: Rng, spec: TierSpec, count: number): { x: number; y: number; r: number }[] {
  const placed: { x: number; y: number; r: number }[] = [];
  const gap = 190;
  let guard = 0;
  while (placed.length < count && guard++ < 4000) {
    const r = rng.range(spec.radius[0], spec.radius[1]);
    // Square-root sampling keeps the disc evenly filled rather than centre-heavy.
    const rad = Math.sqrt(rng.next()) * spec.spread;
    const a = rng.angle();
    const x = Math.cos(a) * rad;
    const y = Math.sin(a) * rad;
    const ok = placed.every((p) => dist(p, { x, y }) > p.r + r + gap);
    if (ok) placed.push({ x, y, r });
  }
  return placed;
}

export function generateLevel(seed: number, index: number): Level {
  const tier = tierFor(index);
  const spec = specFor(index, tier);
  const rng = new Rng(seed ^ Math.imul(index, 0x9e3779b1));

  const planetCount = rng.int(spec.planets[0], spec.planets[1]);
  const slots = placeBodies(rng, spec, planetCount + spec.blackHoles + spec.repulsors);

  const bodies: Body[] = [];
  const kinds: BodyKind[] = ['rock', 'rock', 'ice', 'lava', 'gas'];

  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    let kind: BodyKind;
    if (i < planetCount) {
      // The first two planets carry the tee and the cup, so keep them honest rock/ice.
      kind = i < 2 ? (rng.chance(0.75) ? 'rock' : 'ice') : rng.pick(kinds);
    } else if (i < planetCount + spec.blackHoles) {
      kind = 'blackhole';
    } else {
      kind = 'repulsor';
    }
    const radius = kind === 'blackhole' ? Math.min(s.r, 46) : kind === 'repulsor' ? Math.min(s.r, 58) : s.r;
    bodies.push(makeBody(rng, i, kind, s.x, s.y, radius));
  }

  if (bodies.length < 2) {
    // Degenerate fallback — guarantees a playable hole even if sampling starved.
    bodies.length = 0;
    bodies.push(makeBody(rng, 0, 'rock', -450, 0, 110));
    bodies.push(makeBody(rng, 1, 'ice', 500, 120, 95));
  }

  // Promote some planets to orbiting bodies for higher tiers.
  const moverCandidates = bodies.filter((b) => b.id >= 2);
  for (let m = 0; m < spec.movers && m < moverCandidates.length; m++) {
    const b = moverCandidates[m];
    const orbitRadius = rng.range(140, 380);
    b.orbit = {
      cx: b.pos.x,
      cy: b.pos.y,
      radius: orbitRadius,
      speed: rng.range(0.12, 0.34) * (rng.chance(0.5) ? 1 : -1),
      phase: rng.angle(),
    };
  }

  // Tee on body 0, cup on the planet furthest from it (never a hazard).
  const startBody = 0;
  const playable = bodies.filter((b) => !b.lethal && b.kind !== 'repulsor' && b.id !== startBody);
  let holeBody = playable[0]?.id ?? 1;
  let best = -1;
  for (const b of playable) {
    const d = dist(b.pos, bodies[startBody].pos);
    if (d > best) {
      best = d;
      holeBody = b.id;
    }
  }

  const startAngle = rng.angle();
  // Bias the cup toward the side facing the tee so it's reachable but not trivial.
  const facing = Math.atan2(
    bodies[startBody].pos.y - bodies[holeBody].pos.y,
    bodies[startBody].pos.x - bodies[holeBody].pos.x,
  );
  const holeAngle = facing + rng.range(-2.2, 2.2);

  const spanRadius = bodies.reduce((mx, b) => {
    const reach = Math.hypot(b.pos.x, b.pos.y) + b.radius + (b.orbit?.radius ?? 0);
    return Math.max(mx, reach);
  }, 0);

  const travel = best > 0 ? best : 800;
  const par = Math.max(2, Math.min(7, Math.round(travel / 950) + (tier === 'Easy' ? 1 : tier === 'Extreme' ? 3 : 2)));

  return {
    seed,
    index,
    bodies,
    startBody,
    startAngle,
    holeBody,
    holeAngle,
    par,
    worldRadius: spanRadius + 1400,
    tier,
  };
}

/** Advances orbiting bodies to absolute time `t` (seconds). Deterministic — no accumulation. */
export function updateBodies(level: Level, t: number): void {
  for (const b of level.bodies) {
    if (!b.orbit) continue;
    const a = b.orbit.phase + b.orbit.speed * t;
    b.pos.x = b.orbit.cx + Math.cos(a) * b.orbit.radius;
    b.pos.y = b.orbit.cy + Math.sin(a) * b.orbit.radius;
  }
}

/** Surface point for an anchor expressed as (body, angle). */
export function surfacePoint(body: Body, angle: number, offset = 0): { x: number; y: number } {
  return {
    x: body.pos.x + Math.cos(angle) * (body.radius + offset),
    y: body.pos.y + Math.sin(angle) * (body.radius + offset),
  };
}
