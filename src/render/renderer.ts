import type { Vec } from '../core/vec';
import { surfacePoint } from '../game/generator';
import type { Ball, Body, Level } from '../game/types';
import type { Camera } from './camera';

export interface GhostView {
  id: string;
  name: string;
  hue: number;
  x: number;
  y: number;
  state: string;
  strokes: number;
}

const OUTCOME_COLOR: Record<string, string> = {
  open: 'rgba(140, 220, 255, ',
  sunk: 'rgba(120, 255, 170, ',
  lost: 'rgba(255, 170, 90, ',
  crush: 'rgba(255, 100, 130, ',
  stop: 'rgba(190, 205, 230, ',
};

// Higher-contrast, CVD-distinguishable alternates, keyed the same as OUTCOME_COLOR.
const OUTCOME_COLOR_CB: Record<string, string> = {
  open: 'rgba(80, 160, 255, ',   // blue
  sunk: 'rgba(255, 255, 255, ',  // white
  lost: 'rgba(255, 176, 0, ',    // amber
  crush: 'rgba(0, 0, 0, ',       // black core (still visible via the dotted glow)
  stop: 'rgba(150, 150, 150, ',
};
const OUTCOME_LABEL: Record<string, string> = {
  open: 'FLY', sunk: 'SINK', lost: 'OUT', crush: 'HOLE', stop: 'STOP',
};

export function drawBody(ctx: CanvasRenderingContext2D, cam: Camera, b: Body, time: number): void {
  const s = cam.worldToScreen(b.pos);
  const r = b.radius * cam.zoom;

  if (b.kind === 'blackhole') {
    const halo = r * 3.4;
    const g = ctx.createRadialGradient(s.x, s.y, r * 0.7, s.x, s.y, halo);
    g.addColorStop(0, 'rgba(190, 120, 255, 0.55)');
    g.addColorStop(0.35, 'rgba(120, 70, 220, 0.22)');
    g.addColorStop(1, 'rgba(60, 20, 120, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(s.x - halo, s.y - halo, halo * 2, halo * 2);

    // Accretion disc: a few counter-rotating arcs read as motion at any zoom.
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(time * 0.8);
    for (let i = 0; i < 3; i++) {
      ctx.strokeStyle = `hsla(${280 + i * 18}, 100%, ${68 - i * 8}%, ${0.5 - i * 0.12})`;
      ctx.lineWidth = Math.max(1, r * 0.14);
      ctx.beginPath();
      ctx.arc(0, 0, r * (1.35 + i * 0.32), i * 1.9, i * 1.9 + 2.6);
      ctx.stroke();
    }
    ctx.restore();

    ctx.fillStyle = '#04030a';
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(210, 160, 255, 0.75)';
    ctx.lineWidth = Math.max(1, r * 0.08);
    ctx.stroke();
    return;
  }

  if (b.ring) {
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(b.ring.tilt);
    ctx.scale(1, 0.28);
    ctx.strokeStyle = `hsla(${b.hue}, 55%, 72%, 0.35)`;
    ctx.lineWidth = Math.max(1, r * (b.ring.outer - b.ring.inner) * 0.9);
    ctx.beginPath();
    ctx.arc(0, 0, r * (b.ring.inner + b.ring.outer) * 0.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  const glowR = r * (b.kind === 'repulsor' ? 2.6 : 1.9);
  const glow = ctx.createRadialGradient(s.x, s.y, r * 0.85, s.x, s.y, glowR);
  glow.addColorStop(0, `hsla(${b.hue}, 90%, 62%, ${b.kind === 'repulsor' ? 0.4 : 0.22})`);
  glow.addColorStop(1, `hsla(${b.hue}, 90%, 60%, 0)`);
  ctx.fillStyle = glow;
  ctx.fillRect(s.x - glowR, s.y - glowR, glowR * 2, glowR * 2);

  // Body fill: offset gradient fakes a light source from the upper-left.
  const light = ctx.createRadialGradient(s.x - r * 0.4, s.y - r * 0.45, r * 0.1, s.x, s.y, r);
  const lum = b.kind === 'lava' ? 52 : b.kind === 'ice' ? 78 : b.kind === 'gas' ? 60 : 55;
  light.addColorStop(0, `hsl(${b.hue}, 62%, ${lum + 18}%)`);
  light.addColorStop(0.62, `hsl(${b.hue}, 55%, ${lum}%)`);
  light.addColorStop(1, `hsl(${b.hue + 8}, 48%, ${Math.max(10, lum - 34)}%)`);
  ctx.fillStyle = light;
  ctx.beginPath();
  ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
  ctx.fill();

  if (r > 14) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.clip();
    if (b.kind === 'gas') {
      for (let i = 0; i < 5; i++) {
        const y = s.y - r + ((i + 0.5) / 5) * r * 2 + Math.sin(time * 0.4 + i) * r * 0.05;
        ctx.fillStyle = `hsla(${b.hue + (i % 2 ? 14 : -14)}, 60%, ${lum + (i % 2 ? 10 : -8)}%, 0.5)`;
        ctx.fillRect(s.x - r, y - r * 0.11, r * 2, r * 0.22);
      }
    } else if (b.kind === 'lava') {
      for (const c of b.craters) {
        const cx = s.x + Math.cos(c.a) * c.d * r;
        const cy = s.y + Math.sin(c.a) * c.d * r;
        const pulse = 0.6 + 0.4 * Math.sin(time * 2 + c.a * 3);
        ctx.fillStyle = `hsla(38, 100%, 62%, ${0.55 * pulse})`;
        ctx.beginPath();
        ctx.arc(cx, cy, c.r * r * 1.3, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      for (const c of b.craters) {
        const cx = s.x + Math.cos(c.a) * c.d * r;
        const cy = s.y + Math.sin(c.a) * c.d * r;
        ctx.fillStyle = `hsla(${b.hue}, 40%, ${Math.max(8, lum - 20)}%, 0.55)`;
        ctx.beginPath();
        ctx.arc(cx, cy, c.r * r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  ctx.strokeStyle = `hsla(${b.hue}, 85%, 78%, 0.5)`;
  ctx.lineWidth = Math.max(0.8, r * 0.03);
  ctx.beginPath();
  ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
  ctx.stroke();

  if (b.kind === 'repulsor') {
    ctx.save();
    ctx.strokeStyle = 'hsla(155, 100%, 70%, 0.5)';
    ctx.lineWidth = Math.max(1, r * 0.05);
    for (let i = 0; i < 3; i++) {
      const t = ((time * 0.6 + i / 3) % 1);
      ctx.globalAlpha = (1 - t) * 0.6;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r * (1 + t * 1.7), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
}

export function drawOrbitPath(ctx: CanvasRenderingContext2D, cam: Camera, b: Body): void {
  if (!b.orbit) return;
  const c = cam.worldToScreen({ x: b.orbit.cx, y: b.orbit.cy });
  ctx.save();
  ctx.setLineDash([6, 8]);
  ctx.strokeStyle = 'rgba(150, 180, 230, 0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(c.x, c.y, b.orbit.radius * cam.zoom, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

export function drawHole(ctx: CanvasRenderingContext2D, cam: Camera, level: Level, time: number): void {
  const body = level.bodies[level.holeBody];
  const p = surfacePoint(body, level.holeAngle, -1);
  const s = cam.worldToScreen(p);
  const r = Math.max(3, 11 * cam.zoom);
  const angle = level.holeAngle;

  // Beacon so the cup is findable when zoomed out.
  const beam = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r * 9);
  const pulse = 0.5 + 0.5 * Math.sin(time * 2.4);
  beam.addColorStop(0, `rgba(120, 255, 190, ${0.35 + pulse * 0.2})`);
  beam.addColorStop(1, 'rgba(120, 255, 190, 0)');
  ctx.fillStyle = beam;
  ctx.fillRect(s.x - r * 9, s.y - r * 9, r * 18, r * 18);

  ctx.save();
  ctx.translate(s.x, s.y);
  ctx.rotate(angle + Math.PI / 2);
  ctx.scale(1, 0.45);
  ctx.fillStyle = '#03110c';
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(130, 255, 195, 0.9)';
  ctx.lineWidth = Math.max(1, r * 0.22);
  ctx.stroke();
  ctx.restore();

  // Flag pole pointing straight out from the planet surface.
  const poleLen = Math.max(16, 46 * cam.zoom);
  const tip = { x: s.x + Math.cos(angle) * poleLen, y: s.y + Math.sin(angle) * poleLen };
  ctx.strokeStyle = 'rgba(220, 240, 255, 0.9)';
  ctx.lineWidth = Math.max(1, 2 * cam.zoom);
  ctx.beginPath();
  ctx.moveTo(s.x, s.y);
  ctx.lineTo(tip.x, tip.y);
  ctx.stroke();

  const flagW = poleLen * 0.55;
  const wave = Math.sin(time * 3) * flagW * 0.16;
  const px = Math.cos(angle + Math.PI / 2);
  const py = Math.sin(angle + Math.PI / 2);
  ctx.fillStyle = '#4dffb0';
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(tip.x + px * flagW + Math.cos(angle) * wave, tip.y + py * flagW + Math.sin(angle) * wave);
  ctx.lineTo(tip.x + px * flagW * 0.15 - Math.cos(angle) * flagW * 0.5, tip.y + py * flagW * 0.15 - Math.sin(angle) * flagW * 0.5);
  ctx.closePath();
  ctx.fill();
}

export function drawTrail(ctx: CanvasRenderingContext2D, cam: Camera, trail: Vec[]): void {
  if (trail.length < 2) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  for (let i = 1; i < trail.length; i++) {
    const t = i / trail.length;
    const a = cam.worldToScreen(trail[i - 1]);
    const b = cam.worldToScreen(trail[i]);
    ctx.strokeStyle = `rgba(120, 210, 255, ${t * 0.5})`;
    ctx.lineWidth = Math.max(0.5, t * 3.2 * Math.max(0.35, cam.zoom));
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawBall(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  ball: Ball,
  time: number,
  skin: { body: [string, string]; glow: string },
): void {
  if (ball.state === 'lost') return;
  const s = cam.worldToScreen(ball.pos);
  const r = Math.max(3.2, ball.radius * cam.zoom);

  const glowR = r * 4;
  const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, glowR);
  g.addColorStop(0, skin.glow);
  g.addColorStop(1, 'rgba(120, 200, 255, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(s.x - glowR, s.y - glowR, glowR * 2, glowR * 2);

  const body = ctx.createRadialGradient(s.x - r * 0.35, s.y - r * 0.4, r * 0.1, s.x, s.y, r);
  body.addColorStop(0, skin.body[0]);
  body.addColorStop(1, skin.body[1]);
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
  ctx.fill();

  if (ball.state === 'sunk') {
    const ring = r * (2 + ((time * 1.5) % 1) * 4);
    ctx.strokeStyle = `rgba(120, 255, 190, ${0.6 * (1 - ((time * 1.5) % 1))})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(s.x, s.y, ring, 0, Math.PI * 2);
    ctx.stroke();
  }
}

export function drawGhost(ctx: CanvasRenderingContext2D, cam: Camera, g: GhostView, showNames: boolean): void {
  const s = cam.worldToScreen({ x: g.x, y: g.y });
  const r = Math.max(3, 7 * cam.zoom);
  ctx.save();
  ctx.globalAlpha = g.state === 'sunk' ? 0.45 : 0.72;
  const glowR = r * 3;
  const glow = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, glowR);
  glow.addColorStop(0, `hsla(${g.hue}, 100%, 70%, 0.45)`);
  glow.addColorStop(1, `hsla(${g.hue}, 100%, 60%, 0)`);
  ctx.fillStyle = glow;
  ctx.fillRect(s.x - glowR, s.y - glowR, glowR * 2, glowR * 2);

  ctx.fillStyle = `hsla(${g.hue}, 95%, 72%, 0.55)`;
  ctx.beginPath();
  ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = `hsla(${g.hue}, 100%, 82%, 0.95)`;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  if (showNames) {
    ctx.globalAlpha = 0.9;
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = `hsla(${g.hue}, 100%, 85%, 0.95)`;
    ctx.fillText(g.name, s.x, s.y - r - 8);
  }
  ctx.restore();
}

export function drawAim(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  origin: Vec,
  points: Vec[],
  outcome: string,
  power: number,
  aimDir: Vec,
  time: number,
  colorblind: boolean,
): void {
  const palette = colorblind ? OUTCOME_COLOR_CB : OUTCOME_COLOR;
  const base = palette[outcome] ?? palette.open;
  ctx.save();

  // Predicted path as marching dots — spacing conveys speed.
  for (let i = 0; i < points.length; i++) {
    const p = cam.worldToScreen(points[i]);
    const t = i / Math.max(1, points.length - 1);
    const phase = (i * 0.11 - time * 1.6) % 1;
    const pulse = 0.6 + 0.4 * Math.cos(phase * Math.PI * 2);
    ctx.fillStyle = base + (0.85 * (1 - t * 0.75) * pulse).toFixed(3) + ')';
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(1.1, 2.6 * (1 - t * 0.5)), 0, Math.PI * 2);
    ctx.fill();
  }

  if (points.length > 1) {
    const end = cam.worldToScreen(points[points.length - 1]);
    ctx.strokeStyle = base + '0.8)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(end.x, end.y, 7 + Math.sin(time * 5) * 1.5, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Power arrow anchored on the ball.
  const o = cam.worldToScreen(origin);
  const armLen = 26 + power * 62;
  const tip = { x: o.x + aimDir.x * armLen, y: o.y + aimDir.y * armLen };
  const grad = ctx.createLinearGradient(o.x, o.y, tip.x, tip.y);
  grad.addColorStop(0, 'rgba(255,255,255,0.15)');
  grad.addColorStop(1, `hsla(${170 - power * 170}, 100%, 62%, 0.95)`);
  ctx.strokeStyle = grad;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(o.x, o.y);
  ctx.lineTo(tip.x, tip.y);
  ctx.stroke();

  const ah = 9;
  const a = Math.atan2(aimDir.y, aimDir.x);
  ctx.fillStyle = `hsla(${170 - power * 170}, 100%, 62%, 0.95)`;
  ctx.beginPath();
  ctx.moveTo(tip.x + Math.cos(a) * ah, tip.y + Math.sin(a) * ah);
  ctx.lineTo(tip.x + Math.cos(a + 2.5) * ah, tip.y + Math.sin(a + 2.5) * ah);
  ctx.lineTo(tip.x + Math.cos(a - 2.5) * ah, tip.y + Math.sin(a - 2.5) * ah);
  ctx.closePath();
  ctx.fill();

  // Power meter ring around the ball.
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(o.x, o.y, 18, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = `hsla(${170 - power * 170}, 100%, 62%, 0.95)`;
  ctx.beginPath();
  ctx.arc(o.x, o.y, 18, -Math.PI / 2, -Math.PI / 2 + power * Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  if (colorblind && points.length) {
    const end = cam.worldToScreen(points[points.length - 1]);
    ctx.save();
    ctx.font = '700 12px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 3;
    const txt = OUTCOME_LABEL[outcome] ?? '';
    ctx.strokeText(txt, end.x, end.y - 14);
    ctx.fillText(txt, end.x, end.y - 14);
    ctx.restore();
  }
}

/** Screen-edge chevron pointing at an off-screen world point. */
export function drawOffscreenMarker(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  target: Vec,
  color: string,
  label: string,
): void {
  const s = cam.worldToScreen(target);
  const pad = 46;
  if (s.x > pad && s.x < cam.viewW - pad && s.y > pad && s.y < cam.viewH - pad) return;
  const cx = cam.viewW / 2;
  const cy = cam.viewH / 2;
  const dx = s.x - cx;
  const dy = s.y - cy;
  const a = Math.atan2(dy, dx);
  const mx = Math.min(cx - pad, cy - pad === 0 ? cx - pad : (cx - pad));
  const my = cy - pad;
  // Project onto the viewport rectangle edge.
  const scale = Math.min(Math.abs(mx / (dx || 1e-6)), Math.abs(my / (dy || 1e-6)));
  const x = cx + dx * scale;
  const y = cy + dy * scale;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(a);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(10, 0);
  ctx.lineTo(-7, 7);
  ctx.lineTo(-7, -7);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = color;
  ctx.fillText(label, x - Math.cos(a) * 20, y - Math.sin(a) * 20 + 3);
  ctx.restore();
}
