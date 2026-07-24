import { Rng } from '../core/rng';
import type { Camera } from './camera';

interface Star {
  x: number;
  y: number;
  r: number;
  a: number;
  /** Parallax depth: 0.15 = far and slow, 0.7 = near and fast. */
  depth: number;
  twinkle: number;
}

interface Nebula {
  x: number;
  y: number;
  r: number;
  hue: number;
  alpha: number;
}

/** Stars live in a wrapping screen-space field, so the sky is infinite for free. */
export class Starfield {
  private stars: Star[] = [];
  private nebulae: Nebula[] = [];
  private tile = 1600;

  constructor(seed: number, count = 420) {
    const rng = new Rng(seed);
    for (let i = 0; i < count; i++) {
      const depth = rng.range(0.12, 0.75);
      this.stars.push({
        x: rng.range(0, this.tile),
        y: rng.range(0, this.tile),
        r: rng.range(0.4, 1.7) * (0.6 + depth),
        a: rng.range(0.25, 0.95),
        depth,
        twinkle: rng.range(0, Math.PI * 2),
      });
    }
    for (let i = 0; i < 7; i++) {
      this.nebulae.push({
        x: rng.range(0, this.tile),
        y: rng.range(0, this.tile),
        r: rng.range(420, 900),
        hue: rng.range(210, 320),
        alpha: rng.range(0.05, 0.13),
      });
    }
  }

  draw(ctx: CanvasRenderingContext2D, cam: Camera, time: number, quality: number): void {
    const { viewW: w, viewH: h } = cam;
    ctx.save();

    for (const n of this.nebulae) {
      const ox = -cam.pos.x * cam.zoom * 0.06;
      const oy = -cam.pos.y * cam.zoom * 0.06;
      const x = ((((n.x + ox) % this.tile) + this.tile) % this.tile) - this.tile / 2 + w / 2;
      const y = ((((n.y + oy) % this.tile) + this.tile) % this.tile) - this.tile / 2 + h / 2;
      const g = ctx.createRadialGradient(x, y, 0, x, y, n.r);
      g.addColorStop(0, `hsla(${n.hue}, 80%, 55%, ${n.alpha})`);
      g.addColorStop(1, 'hsla(240, 80%, 40%, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - n.r, y - n.r, n.r * 2, n.r * 2);
    }

    const step = quality >= 2 ? 1 : 2;
    for (let i = 0; i < this.stars.length; i += step) {
      const s = this.stars[i];
      const ox = -cam.pos.x * cam.zoom * s.depth * 0.35;
      const oy = -cam.pos.y * cam.zoom * s.depth * 0.35;
      const x = ((((s.x + ox) % this.tile) + this.tile) % this.tile) - this.tile / 2 + w / 2;
      const y = ((((s.y + oy) % this.tile) + this.tile) % this.tile) - this.tile / 2 + h / 2;
      if (x < -8 || x > w + 8 || y < -8 || y > h + 8) continue;
      const tw = quality >= 1 ? 0.75 + 0.25 * Math.sin(time * 1.7 + s.twinkle) : 1;
      ctx.globalAlpha = s.a * tw;
      ctx.fillStyle = i % 11 === 0 ? '#9fd4ff' : i % 7 === 0 ? '#ffe5c2' : '#ffffff';
      ctx.beginPath();
      ctx.arc(x, y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}
