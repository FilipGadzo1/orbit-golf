import { Rng } from '../core/rng';
import type { Vec } from '../core/vec';
import { gravityAt } from '../game/physics';
import type { Body } from '../game/types';
import type { Camera } from './camera';

interface Particle {
  x: number;
  y: number;
  px: number;
  py: number;
  life: number;
  maxLife: number;
  /** Field magnitude sampled at the particle — drives brightness, not screen speed. */
  mag: number;
}

/**
 * Advects massless tracer particles along the gravity field and draws them as streaks.
 * This is the game's main "gravity is visible" affordance — flow direction and density
 * read directly as pull strength.
 */
export class GravityField {
  private particles: Particle[] = [];
  private rng = new Rng(1337);
  private accel: Vec = { x: 0, y: 0 };

  constructor(private count = 340) {}

  setCount(n: number): void {
    this.count = n;
    if (this.particles.length > n) this.particles.length = n;
  }

  private spawn(cam: Camera): Particle {
    const margin = 120 / cam.zoom;
    const halfW = cam.viewW / 2 / cam.zoom + margin;
    const halfH = cam.viewH / 2 / cam.zoom + margin;
    const x = cam.pos.x + this.rng.range(-halfW, halfW);
    const y = cam.pos.y + this.rng.range(-halfH, halfH);
    const maxLife = this.rng.range(1.1, 3.4);
    return { x, y, px: x, py: y, life: this.rng.range(0, maxLife), maxLife, mag: 0 };
  }

  update(bodies: Body[], cam: Camera, dt: number): void {
    while (this.particles.length < this.count) this.particles.push(this.spawn(cam));

    const halfW = cam.viewW / 2 / cam.zoom + 200 / cam.zoom;
    const halfH = cam.viewH / 2 / cam.zoom + 200 / cam.zoom;

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      p.life -= dt;
      const off =
        Math.abs(p.x - cam.pos.x) > halfW || Math.abs(p.y - cam.pos.y) > halfH;
      if (p.life <= 0 || off) {
        this.particles[i] = this.spawn(cam);
        continue;
      }
      gravityAt(bodies, p.x, p.y, this.accel);
      const mag = Math.hypot(this.accel.x, this.accel.y) || 1e-6;
      p.mag = mag;
      // Normalised direction with a mild speed response, so far-field flow stays legible.
      const speed = Math.min(900, 90 + Math.sqrt(mag) * 34);
      p.px = p.x;
      p.py = p.y;
      p.x += (this.accel.x / mag) * speed * dt;
      p.y += (this.accel.y / mag) * speed * dt;
    }
  }

  draw(ctx: CanvasRenderingContext2D, cam: Camera, bodies: Body[], intensity: number): void {
    if (intensity <= 0) return;
    ctx.save();
    ctx.lineCap = 'round';

    // Soft potential wells make each body's reach obvious even when standing still.
    for (const b of bodies) {
      const reach = b.radius * (b.kind === 'blackhole' ? 11 : 6.5);
      if (!cam.visible(b.pos, reach)) continue;
      const s = cam.worldToScreen(b.pos);
      const r = reach * cam.zoom;
      const hue = b.mass < 0 ? 150 : b.kind === 'blackhole' ? 285 : 205;
      const g = ctx.createRadialGradient(s.x, s.y, b.radius * cam.zoom, s.x, s.y, r);
      g.addColorStop(0, `hsla(${hue}, 95%, 62%, ${0.3 * intensity})`);
      g.addColorStop(0.3, `hsla(${hue}, 95%, 60%, ${0.12 * intensity})`);
      g.addColorStop(0.65, `hsla(${hue}, 95%, 60%, ${0.04 * intensity})`);
      g.addColorStop(1, `hsla(${hue}, 95%, 60%, 0)`);
      ctx.fillStyle = g;
      ctx.fillRect(s.x - r, s.y - r, r * 2, r * 2);

      // Equipotential rings: concrete, countable markers of how far the pull reaches.
      ctx.setLineDash([3, 9]);
      for (let i = 1; i <= 4; i++) {
        const rr = b.radius * cam.zoom * (1 + i * 1.3);
        if (rr < 8 || rr > Math.max(cam.viewW, cam.viewH)) continue;
        ctx.strokeStyle = `hsla(${hue}, 95%, 70%, ${(0.22 / i) * intensity})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(s.x, s.y, rr, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      const a = cam.worldToScreen({ x: p.px, y: p.py });
      const b = cam.worldToScreen({ x: p.x, y: p.y });
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const screenSpeed = Math.hypot(dx, dy);
      if (screenSpeed < 0.01) continue;
      const fade = Math.min(1, p.life / 0.6) * Math.min(1, (p.maxLife - p.life) / 0.4);
      // Brightness tracks field strength rather than on-screen speed, so the streaks stay
      // readable when zoomed all the way out to see a whole solar system.
      const strength = Math.min(1, Math.sqrt(p.mag) / 22);
      const alpha = (0.16 + strength * 0.55) * fade * intensity;
      const tail = Math.max(5, Math.min(34, screenSpeed * 2.6 + strength * 12));
      const nx = dx / screenSpeed;
      const ny = dy / screenSpeed;
      ctx.strokeStyle = `hsla(${196 + strength * 58}, 100%, ${68 + strength * 20}%, ${alpha})`;
      ctx.lineWidth = 1 + strength * 1.2;
      ctx.beginPath();
      ctx.moveTo(b.x - nx * tail, b.y - ny * tail);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }
}
