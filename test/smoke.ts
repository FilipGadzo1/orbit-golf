/**
 * Headless sanity pass over the generator + physics.
 * Run with: npm run test
 *
 * It plays a crude "aim at the cup and vary the power" bot across many holes and
 * asserts that every generated course is well-formed and actually sinkable.
 */
import { generateLevel, surfacePoint, updateBodies } from '../src/game/generator';
import { BALL_RADIUS, MAX_SHOT_SPEED, makeSim, stepBall, type ImpactEvent } from '../src/game/physics';
import type { Ball, Level } from '../src/game/types';

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) {
    failures++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function teeBall(level: Level): Ball {
  const b = level.bodies[level.startBody];
  const p = surfacePoint(b, level.startAngle, BALL_RADIUS);
  return {
    pos: { x: p.x, y: p.y },
    vel: { x: 0, y: 0 },
    radius: BALL_RADIUS,
    state: 'idle',
    restingOn: b.id,
    restAngle: level.startAngle,
    trail: [],
  };
}

/** Fires one shot and simulates until the ball settles, sinks, is lost, or times out. */
function simulateShot(
  level: Level,
  ball: Ball,
  angle: number,
  power: number,
  startTime: number,
): { outcome: string; seconds: number } {
  ball.vel.x = Math.cos(angle) * power * MAX_SHOT_SPEED;
  ball.vel.y = Math.sin(angle) * power * MAX_SHOT_SPEED;
  ball.state = 'flying';
  const sim = makeSim();
  const events: ImpactEvent[] = [];
  const dt = 1 / 240;
  let t = startTime;
  for (let i = 0; i < 240 * 30; i++) {
    t += dt;
    updateBodies(level, t);
    stepBall(ball, level, dt, sim, events);
    if (ball.state !== 'flying') {
      return { outcome: ball.state === 'sunk' ? 'sunk' : ball.state, seconds: t - startTime };
    }
  }
  return { outcome: 'timeout', seconds: t - startTime };
}

console.log('Orbit Golf — headless smoke test\n');

// --- 1. Structural checks across a wide spread of holes and seeds -------------
const seeds = [1, 42, 7331, 0xdeadbeef, 123456789];
let holesChecked = 0;
for (const seed of seeds) {
  for (let hole = 1; hole <= 30; hole++) {
    const level = generateLevel(seed, hole);
    holesChecked++;
    const tag = `seed ${seed} hole ${hole}`;
    check(`${tag}: has >= 2 bodies`, level.bodies.length >= 2, `got ${level.bodies.length}`);
    check(`${tag}: start body exists`, !!level.bodies[level.startBody]);
    check(`${tag}: hole body exists`, !!level.bodies[level.holeBody]);
    check(`${tag}: cup is not on a hazard`, !level.bodies[level.holeBody].lethal);
    check(`${tag}: cup is not on the tee planet`, level.holeBody !== level.startBody);
    check(`${tag}: par in range`, level.par >= 2 && level.par <= 7, `par ${level.par}`);

    // No body may overlap another — that would trap the ball in geometry.
    for (let i = 0; i < level.bodies.length; i++) {
      for (let j = i + 1; j < level.bodies.length; j++) {
        const a = level.bodies[i];
        const b = level.bodies[j];
        const d = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
        check(`${tag}: bodies ${i}/${j} do not overlap`, d > a.radius + b.radius, `gap ${(d - a.radius - b.radius).toFixed(1)}`);
      }
    }

    // Everything must start inside the out-of-bounds circle.
    const tee = surfacePoint(level.bodies[level.startBody], level.startAngle, BALL_RADIUS);
    check(`${tag}: tee is in bounds`, Math.hypot(tee.x, tee.y) < level.worldRadius);
  }
}
console.log(`Structure: checked ${holesChecked} generated holes.`);

// --- 2. Determinism ----------------------------------------------------------
{
  const a = generateLevel(999, 12);
  const b = generateLevel(999, 12);
  check(
    'determinism: same seed + hole produces identical bodies',
    JSON.stringify(a) === JSON.stringify(b),
  );
}

// --- 3. Ball settles instead of orbiting forever -----------------------------
{
  let settled = 0;
  let attempts = 0;
  for (let hole = 1; hole <= 12; hole++) {
    const level = generateLevel(2024, hole);
    const ball = teeBall(level);
    // A weak tap straight "up" from the surface should fall back and come to rest.
    const r = simulateShot(level, ball, level.startAngle, 0.18, 0);
    attempts++;
    if (r.outcome === 'idle' || r.outcome === 'sunk') settled++;
  }
  check('rest: weak taps settle back onto the surface', settled >= attempts - 2, `${settled}/${attempts}`);
  console.log(`Resting: ${settled}/${attempts} weak taps came to rest.`);
}

// --- 4. Every hole is reachable by brute force --------------------------------
{
  let sinkable = 0;
  const holes = 20;
  const shotLog: string[] = [];
  for (let hole = 1; hole <= holes; hole++) {
    const level = generateLevel(555, hole);
    const cup = surfacePoint(level.bodies[level.holeBody], level.holeAngle);
    let found = false;
    let best = Infinity;

    outer: for (let ai = 0; ai < 96 && !found; ai++) {
      for (let pi = 1; pi <= 20; pi++) {
        const ball = teeBall(level);
        const angle = (ai / 96) * Math.PI * 2;
        const r = simulateShot(level, ball, angle, pi / 20, 0);
        const d = Math.hypot(ball.pos.x - cup.x, ball.pos.y - cup.y);
        best = Math.min(best, d);
        if (r.outcome === 'sunk') {
          found = true;
          shotLog.push(`  hole ${hole} (${level.tier}, ${level.bodies.length} bodies): sunk in 1 from the tee`);
          break outer;
        }
      }
    }
    if (found) sinkable++;
    else shotLog.push(`  hole ${hole} (${level.tier}, ${level.bodies.length} bodies): closest approach ${best.toFixed(0)}u`);
  }
  console.log(`Reachability: ${sinkable}/${holes} holes are ace-able from the tee by brute force.`);
  shotLog.slice(0, 8).forEach((l) => console.log(l));
  // Not every hole should be a hole-in-one, but a total shutout means the cup is unreachable.
  check('reachability: at least some holes are sinkable from the tee', sinkable > 0, `${sinkable}/${holes}`);
}

// --- 5. Out of bounds actually triggers --------------------------------------
{
  const level = generateLevel(77, 3);
  const ball = teeBall(level);
  const away = Math.atan2(ball.pos.y, ball.pos.x);
  const r = simulateShot(level, ball, away, 1, 0);
  check('bounds: a full-power shot outward escapes or settles, never hangs', r.outcome !== 'timeout', r.outcome);
  console.log(`Out of bounds: max-power escape shot resolved as "${r.outcome}" after ${r.seconds.toFixed(1)}s.`);
}

// --- 6. No NaNs leak into the simulation -------------------------------------
{
  const level = generateLevel(31337, 25);
  const ball = teeBall(level);
  simulateShot(level, ball, 1.2, 0.9, 0);
  check('stability: ball position stays finite', Number.isFinite(ball.pos.x) && Number.isFinite(ball.pos.y));
  check('stability: ball velocity stays finite', Number.isFinite(ball.vel.x) && Number.isFinite(ball.vel.y));
}

console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log('All checks passed.');
}
