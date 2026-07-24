import type { Camera } from './camera';

interface P {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  hue: number;
  drag: number;
}

/** Short-lived sparks for impacts, sinks and explosions. */
export class Particles {
  private items: P[] = [];

  burst(
    x: number,
    y: number,
    count: number,
    opts: { hue: number; speed: number; size?: number; spread?: number; dir?: number; life?: number },
  ): void {
    const spread = opts.spread ?? Math.PI * 2;
    const dir = opts.dir ?? 0;
    for (let i = 0; i < count; i++) {
      const a = dir + (Math.random() - 0.5) * spread;
      const s = opts.speed * (0.35 + Math.random() * 0.9);
      const maxLife = (opts.life ?? 0.6) * (0.6 + Math.random() * 0.8);
      this.items.push({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life: maxLife,
        maxLife,
        size: (opts.size ?? 2.4) * (0.6 + Math.random()),
        hue: opts.hue + (Math.random() - 0.5) * 40,
        drag: 1.6 + Math.random(),
      });
    }
    if (this.items.length > 900) this.items.splice(0, this.items.length - 900);
  }

  update(dt: number): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const p = this.items[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.items.splice(i, 1);
        continue;
      }
      const d = Math.exp(-p.drag * dt);
      p.vx *= d;
      p.vy *= d;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
  }

  draw(ctx: CanvasRenderingContext2D, cam: Camera): void {
    if (this.items.length === 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.items) {
      const s = cam.worldToScreen(p);
      const t = p.life / p.maxLife;
      const r = Math.max(0.6, p.size * cam.zoom * (0.4 + t));
      ctx.fillStyle = `hsla(${p.hue}, 100%, ${55 + t * 25}%, ${t * 0.85})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  clear(): void {
    this.items.length = 0;
  }
}
