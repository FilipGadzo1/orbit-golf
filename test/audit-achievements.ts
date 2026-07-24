/**
 * Ad-hoc audit: are all 17 achievements actually reachable by generated content?
 * Samples a large number of holes and reports what the generator really produces.
 */
import { generateLevel } from '../src/game/generator';
import type { BodyKind } from '../src/game/types';

const SEEDS = 400;
const HOLES = 40;

const cupKinds: Record<string, number> = {};
const cupKindFirstSeen: Record<string, string> = {};
let holesWithBlackHole = 0;
let firstBlackHole = '';
let holesWithRepulsor = 0;
const bodyKinds: Record<string, number> = {};
let starvedSlots = 0;
let maxWorldRadius = 0;
let minWorldRadius = Infinity;
const perTierCup: Record<string, Record<string, number>> = {};

for (let s = 0; s < SEEDS; s++) {
  const seed = (s * 2654435761) >>> 0;
  for (let h = 1; h <= HOLES; h++) {
    const lvl = generateLevel(seed, h);
    const cup = lvl.bodies[lvl.holeBody];
    const tag = `seed#${s} hole ${h}`;

    cupKinds[cup.kind] = (cupKinds[cup.kind] ?? 0) + 1;
    if (!cupKindFirstSeen[cup.kind]) cupKindFirstSeen[cup.kind] = tag;

    perTierCup[lvl.tier] ??= {};
    perTierCup[lvl.tier][cup.kind] = (perTierCup[lvl.tier][cup.kind] ?? 0) + 1;

    for (const b of lvl.bodies) bodyKinds[b.kind] = (bodyKinds[b.kind] ?? 0) + 1;

    const hasBH = lvl.bodies.some((b) => b.kind === 'blackhole');
    if (hasBH) {
      holesWithBlackHole++;
      if (!firstBlackHole) firstBlackHole = tag;
    }
    if (lvl.bodies.some((b) => b.kind === 'repulsor')) holesWithRepulsor++;

    // Detect rejection-sampling starvation: fewer bodies than the tier asked for.
    if (lvl.bodies.length < 2) starvedSlots++;
    maxWorldRadius = Math.max(maxWorldRadius, lvl.worldRadius);
    minWorldRadius = Math.min(minWorldRadius, lvl.worldRadius);
  }
}

const total = SEEDS * HOLES;
console.log(`Sampled ${total} generated holes (${SEEDS} seeds x ${HOLES} holes)\n`);

console.log('CUP SURFACE DISTRIBUTION  (drives the "Grand Tour" achievement)');
for (const k of ['rock', 'ice', 'lava', 'gas', 'blackhole', 'repulsor'] as BodyKind[]) {
  const n = cupKinds[k] ?? 0;
  const pct = ((n / total) * 100).toFixed(2);
  const mark = n === 0 ? '  <-- NEVER HAPPENS' : '';
  console.log(`  ${k.padEnd(10)} ${String(n).padStart(6)}  ${pct.padStart(6)}%   first: ${cupKindFirstSeen[k] ?? '—'}${mark}`);
}

console.log('\nCUP SURFACE BY TIER');
for (const tier of ['Easy', 'Medium', 'Hard', 'Extreme']) {
  const row = perTierCup[tier] ?? {};
  const parts = Object.entries(row)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join('  ');
  console.log(`  ${tier.padEnd(8)} ${parts}`);
}

console.log('\nHAZARDS  (drives "Spaghettified")');
console.log(`  holes containing a black hole: ${holesWithBlackHole} (${((holesWithBlackHole / total) * 100).toFixed(2)}%)  first: ${firstBlackHole || '—'}`);
console.log(`  holes containing a repulsor:   ${holesWithRepulsor} (${((holesWithRepulsor / total) * 100).toFixed(2)}%)`);

console.log('\nALL BODY KINDS PLACED');
for (const [k, v] of Object.entries(bodyKinds).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(10)} ${v}`);
}

console.log(`\nWorld radius range: ${minWorldRadius.toFixed(0)} .. ${maxWorldRadius.toFixed(0)} units`);
console.log(`Degenerate (fallback) levels: ${starvedSlots}`);

// ---------------------------------------------------------------------------
// Simulated shots: can a single shot really travel 5,000 units ("Long Bomb"),
// and can a ball stay untouched for 60s ("Lost Contact")?
// ---------------------------------------------------------------------------
const { BALL_RADIUS, MAX_SHOT_SPEED, makeSim, stepBall } = await import('../src/game/physics');
const { surfacePoint, updateBodies } = await import('../src/game/generator');

let bestDistance = 0;
let bestDistanceTag = '';
let bestAirborne = 0;
let bestAirborneTag = '';
let shotsOver5k = 0;
let shotsOver60s = 0;
let shotsSimulated = 0;

for (let s = 0; s < 40; s++) {
  const seed = (s * 40503 + 7) >>> 0;
  for (const h of [1, 5, 10, 16, 24, 32]) {
    const lvl = generateLevel(seed, h);
    const start = lvl.bodies[lvl.startBody];

    for (let ai = 0; ai < 24; ai++) {
      for (const power of [0.55, 0.75, 0.9, 1.0]) {
        const p = surfacePoint(start, lvl.startAngle, BALL_RADIUS);
        const angle = (ai / 24) * Math.PI * 2;
        const ball = {
          pos: { x: p.x, y: p.y },
          vel: { x: Math.cos(angle) * power * MAX_SHOT_SPEED, y: Math.sin(angle) * power * MAX_SHOT_SPEED },
          radius: BALL_RADIUS,
          state: 'flying' as const,
          restingOn: -1,
          restAngle: 0,
          trail: [],
        };
        const sim = makeSim();
        const events: never[] = [];
        const dt = 1 / 240;
        let dist = 0;
        let t = 0;
        shotsSimulated++;

        // Simulate up to 90s of flight — past the 60s no-contact cutoff.
        for (let i = 0; i < 240 * 90; i++) {
          const px = ball.pos.x;
          const py = ball.pos.y;
          t += dt;
          updateBodies(lvl, t);
          stepBall(ball as never, lvl, dt, sim, events as never);
          dist += Math.hypot(ball.pos.x - px, ball.pos.y - py);
          if (sim.contactAge > bestAirborne) {
            bestAirborne = sim.contactAge;
            bestAirborneTag = `seed#${s} hole ${h} angle ${ai} power ${power}`;
          }
          if (ball.state !== 'flying') break;
        }
        if (dist > bestDistance) {
          bestDistance = dist;
          bestDistanceTag = `seed#${s} hole ${h} angle ${ai} power ${power}`;
        }
        if (dist >= 5000) shotsOver5k++;
        if (sim.contactAge >= 60) shotsOver60s++;
      }
    }
  }
}

console.log(`\nSIMULATED SHOTS  (${shotsSimulated} shots from the tee)`);
console.log(`  longest single shot: ${bestDistance.toFixed(0)} units   (${bestDistanceTag})`);
console.log(`  shots >= 5,000 units ("Long Bomb"):  ${shotsOver5k} (${((shotsOver5k / shotsSimulated) * 100).toFixed(2)}%)`);
console.log(`  longest time untouched: ${bestAirborne.toFixed(1)}s   (${bestAirborneTag})`);
console.log(`  shots >= 60s untouched ("Lost Contact"): ${shotsOver60s} (${((shotsOver60s / shotsSimulated) * 100).toFixed(2)}%)`);
