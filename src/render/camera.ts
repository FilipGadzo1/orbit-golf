import { clamp, damp, type Vec } from '../core/vec';

export const MIN_ZOOM = 0.06;
export const MAX_ZOOM = 2.2;

export class Camera {
  pos: Vec = { x: 0, y: 0 };
  zoom = 0.5;
  targetPos: Vec = { x: 0, y: 0 };
  targetZoom = 0.5;
  viewW = 1;
  viewH = 1;
  /** Set false while the player is dragging the view or wheel-zooming. */
  auto = true;

  resize(w: number, h: number): void {
    this.viewW = w;
    this.viewH = h;
  }

  snap(): void {
    this.pos.x = this.targetPos.x;
    this.pos.y = this.targetPos.y;
    this.zoom = this.targetZoom;
  }

  update(dt: number): void {
    this.pos.x = damp(this.pos.x, this.targetPos.x, 6, dt);
    this.pos.y = damp(this.pos.y, this.targetPos.y, 6, dt);
    this.zoom = damp(this.zoom, this.targetZoom, 5, dt);
  }

  setZoom(z: number): void {
    this.targetZoom = clamp(z, MIN_ZOOM, MAX_ZOOM);
  }

  /** Zoom toward a screen anchor so wheel-zoom keeps the cursor over the same world point. */
  zoomAt(factor: number, screen: Vec): void {
    const before = this.screenToWorld(screen);
    this.setZoom(this.targetZoom * factor);
    this.zoom = this.targetZoom;
    const after = this.screenToWorld(screen);
    this.pos.x += before.x - after.x;
    this.pos.y += before.y - after.y;
    this.targetPos.x = this.pos.x;
    this.targetPos.y = this.pos.y;
  }

  worldToScreen(w: Vec): Vec {
    return {
      x: (w.x - this.pos.x) * this.zoom + this.viewW / 2,
      y: (w.y - this.pos.y) * this.zoom + this.viewH / 2,
    };
  }

  screenToWorld(s: Vec): Vec {
    return {
      x: (s.x - this.viewW / 2) / this.zoom + this.pos.x,
      y: (s.y - this.viewH / 2) / this.zoom + this.pos.y,
    };
  }

  /**
   * Frames a set of world points with padding, respecting zoom limits.
   * Points may carry a radius so whole planets — not just their centres — stay in shot.
   */
  frame(points: (Vec & { r?: number })[], padding = 260, maxZoom = MAX_ZOOM): void {
    if (points.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      const r = p.r ?? 0;
      minX = Math.min(minX, p.x - r);
      minY = Math.min(minY, p.y - r);
      maxX = Math.max(maxX, p.x + r);
      maxY = Math.max(maxY, p.y + r);
    }
    const w = maxX - minX + padding * 2;
    const h = maxY - minY + padding * 2;
    this.targetPos.x = (minX + maxX) / 2;
    this.targetPos.y = (minY + maxY) / 2;
    this.targetZoom = clamp(Math.min(this.viewW / w, this.viewH / h), MIN_ZOOM, maxZoom);
  }

  /** True when a world circle could touch the viewport. */
  visible(p: Vec, radius: number): boolean {
    const s = this.worldToScreen(p);
    const r = radius * this.zoom;
    return s.x + r > -80 && s.x - r < this.viewW + 80 && s.y + r > -80 && s.y - r < this.viewH + 80;
  }
}
