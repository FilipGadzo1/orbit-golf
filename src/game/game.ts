import { sfx } from '../audio/sfx';
import { clamp, damp, type Vec } from '../core/vec';
import { NetClient, type NetStatus } from '../net/client';
import type { PlayerInfo } from '../net/protocol';
import { Camera, MAX_ZOOM } from '../render/camera';
import { GravityField } from '../render/gravityfield';
import { Particles } from '../render/particles';
import {
  drawAim,
  drawBall,
  drawBody,
  drawGhost,
  drawHole,
  drawOffscreenMarker,
  drawOrbitPath,
  drawTrail,
  type GhostView,
} from '../render/renderer';
import { Starfield } from '../render/starfield';
import { generateLevel, surfacePoint, updateBodies } from './generator';
import {
  BALL_RADIUS,
  MAX_SHOT_SPEED,
  makeSim,
  predictTrajectory,
  stepBall,
  type ImpactEvent,
  type SimState,
} from './physics';
import type { Settings } from './settings';
import {
  checkAchievements,
  loadStats,
  recordHole,
  recordPenalty,
  recordRun,
  recordShot,
  saveStats,
  type Achievement,
  type Stats,
} from './stats';
import type { Ball, Level } from './types';

const PHYSICS_DT = 1 / 240;
const MAX_DRAG_PX = 210;

export interface HudState {
  hole: number;
  par: number;
  strokes: number;
  tier: string;
  total: number;
  bodies: number;
  status: string;
  zoom: number;
  canShoot: boolean;
  netStatus: NetStatus;
  room: string;
  waiting: boolean;
}

export interface HoleResult {
  hole: number;
  par: number;
  strokes: number;
  outcome: 'sunk' | 'skipped';
  label: string;
  total: number;
}

interface Ghost {
  info: PlayerInfo;
  target: Vec;
  render: Vec;
  seen: number;
}

export class Game {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  readonly cam = new Camera();
  private starfield: Starfield;
  private field = new GravityField();
  private particles = new Particles();
  private sim = makeSim();

  settings: Settings;
  seed = (Math.random() * 0xffffffff) >>> 0;
  holeIndex = 1;
  level!: Level;
  ball!: Ball;
  strokes = 0;
  total = 0;
  time = 0;
  /**
   * A shot runs as long as it likes while it's inside the boundary and still interacting
   * with the course. Only a ball that has touched nothing at all for this many seconds is
   * declared adrift. Exposed as a field so the browser test can shorten it.
   */
  airborneTimeout = 60;
  private lastRest: Vec = { x: 0, y: 0 };
  private lastRestBody = -1;
  private lastRestAngle = 0;

  private running = false;
  private lastFrame = 0;
  private shake = 0;
  private statusMessage = '';
  private statusUntil = 0;
  private holeSettled = false;

  // Input
  private pointers = new Map<number, Vec>();
  private aiming = false;
  private aimStart: Vec = { x: 0, y: 0 };
  private aimCur: Vec = { x: 0, y: 0 };
  private panning = false;
  private panLast: Vec = { x: 0, y: 0 };
  private pinchDist = 0;

  // Multiplayer
  net: NetClient;
  ghosts = new Map<string, Ghost>();
  players: PlayerInfo[] = [];
  private waitingForOthers = false;
  private countdown = 0;

  onHoleComplete: (r: HoleResult) => void = () => {};
  onPlayersChanged: (p: PlayerInfo[]) => void = () => {};
  onNetStatus: (s: NetStatus, detail?: string) => void = () => {};
  onAchievements: (unlocked: Achievement[]) => void = () => {};

  // Career stats
  stats: Stats = loadStats();
  /** Distance and bounces for the shot currently in the air. */
  private shotDistance = 0;
  private shotBounces = 0;
  /** Strokes banked this run, for the best-run record. */
  private runHoles = 0;
  private runStrokes = 0;
  private runRelPar = 0;
  private unsavedPlayTime = 0;

  constructor(canvas: HTMLCanvasElement, settings: Settings) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is not available in this browser.');
    this.ctx = ctx;
    this.settings = settings;
    this.starfield = new Starfield(this.seed);

    this.net = new NetClient({
      onWelcome: (m) => {
        this.seed = m.seed;
        this.starfield = new Starfield(this.seed);
        this.players = m.players;
        this.syncGhosts();
        this.loadHole(m.hole);
        this.onPlayersChanged(this.players);
        sfx.join();
        this.flash(`Joined room ${m.room}`);
      },
      onPlayers: (players) => {
        this.players = players;
        this.syncGhosts();
        this.onPlayersChanged(players);
      },
      onPos: (id, x, y, state) => {
        const g = this.ghosts.get(id);
        if (!g) return;
        g.target.x = x;
        g.target.y = y;
        g.info.state = state as PlayerInfo['state'];
        g.seen = performance.now();
      },
      onHole: (hole, players) => {
        this.players = players;
        this.syncGhosts();
        this.total = players.find((p) => p.id === this.net.selfId)?.total ?? this.total;
        this.countdown = 0;
        this.waitingForOthers = false;
        this.loadHole(hole);
        this.onPlayersChanged(players);
        sfx.levelUp();
      },
      onCountdown: (s) => {
        this.countdown = performance.now() + s * 1000;
      },
      onStatus: (s, detail) => this.onNetStatus(s, detail),
    });

    this.applySettings(settings);
    this.bindInput();
  }

  applySettings(s: Settings): void {
    this.settings = s;
    sfx.enabled = s.soundEnabled;
    sfx.setVolume(s.volume);
    this.field.setCount(s.quality === 0 ? 90 : s.quality === 1 ? 220 : 400);
  }

  // ---------------------------------------------------------------- lifecycle

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
  }

  newCourse(seed?: number): void {
    this.bankRun();
    this.seed = seed ?? (Math.random() * 0xffffffff) >>> 0;
    this.starfield = new Starfield(this.seed);
    this.total = 0;
    this.stats.coursesStarted++;
    this.flushStats();
    this.loadHole(1);
  }

  /** Records the run that just ended (if any) as a possible personal best. */
  bankRun(): void {
    if (this.runHoles > 0) {
      recordRun(this.stats, this.runHoles, this.runStrokes, this.runRelPar);
      this.announce();
    }
    this.runHoles = 0;
    this.runStrokes = 0;
    this.runRelPar = 0;
  }

  private flushStats(): void {
    this.stats.playTime += this.unsavedPlayTime;
    this.unsavedPlayTime = 0;
    saveStats(this.stats);
  }

  /** Unlocks anything newly earned and hands it to the UI. */
  private announce(): void {
    const unlocked = checkAchievements(this.stats);
    if (unlocked.length) this.onAchievements(unlocked);
  }

  loadHole(index: number): void {
    this.holeIndex = index;
    this.level = generateLevel(this.seed, index);
    this.time = 0;
    this.strokes = 0;
    this.holeSettled = false;
    this.waitingForOthers = false;
    updateBodies(this.level, 0);

    const startBody = this.level.bodies[this.level.startBody];
    const p = surfacePoint(startBody, this.level.startAngle, BALL_RADIUS);
    this.ball = {
      pos: { x: p.x, y: p.y },
      vel: { x: 0, y: 0 },
      radius: BALL_RADIUS,
      state: 'idle',
      restingOn: startBody.id,
      restAngle: this.level.startAngle,
      trail: [],
    };
    this.lastRest = { x: p.x, y: p.y };
    this.lastRestBody = startBody.id;
    this.lastRestAngle = this.level.startAngle;
    this.particles.clear();
    this.sim = makeSim();

    // Open on the full course so the player reads the layout, then settle to the tee.
    this.cam.frame(
      this.level.bodies.map((b) => ({ x: b.pos.x, y: b.pos.y, r: b.radius })),
      420,
      0.8,
    );
    this.cam.snap();
    this.cam.auto = this.settings.autoCamera;
    this.flash(`Hole ${index} · Par ${this.level.par} · ${this.level.tier}`);
  }

  /** Give up on the current hole (counts as par + 2). */
  skipHole(): void {
    if (this.holeSettled) return;
    this.holeSettled = true;
    const penalty = this.level.par + 2;
    this.strokes = Math.max(this.strokes, penalty);
    this.finishHole('skipped');
  }

  nextHole(): void {
    if (this.net.connected) {
      this.net.send({ t: 'ready' });
      this.waitingForOthers = true;
      return;
    }
    this.total += this.strokes;
    this.loadHole(this.holeIndex + 1);
  }

  /**
   * Puts the ball back on the tee. In multiplayer the strokes already played are kept and
   * a penalty stroke is added — otherwise a restart would be a free do-over that solo
   * players don't get scored on but lobby-mates would be competing against.
   */
  restartHole(): void {
    const competitive = this.net.connected;
    const carried = this.strokes;
    this.loadHole(this.holeIndex);
    if (!competitive) return;
    this.strokes = carried;
    // penalise() adds the stroke, re-tees the ball and broadcasts the new count.
    this.penalise('retry');
  }

  private finishHole(outcome: 'sunk' | 'skipped'): void {
    const diff = this.strokes - this.level.par;
    const label =
      outcome === 'skipped'
        ? 'Conceded'
        : this.strokes === 1
          ? 'Hole in one!'
          : diff <= -3
            ? 'Albatross'
            : diff === -2
              ? 'Eagle'
              : diff === -1
                ? 'Birdie'
                : diff === 0
                  ? 'Par'
                  : diff === 1
                    ? 'Bogey'
                    : diff === 2
                      ? 'Double bogey'
                      : `+${diff}`;

    recordHole(this.stats, {
      hole: this.holeIndex,
      par: this.level.par,
      strokes: this.strokes,
      outcome,
      tier: this.level.tier,
      cupSurface: this.level.bodies[this.level.holeBody].kind,
      multiplayer: this.net.connected && this.players.length > 1,
    });
    this.runHoles++;
    this.runStrokes += this.strokes;
    this.runRelPar += diff;
    this.flushStats();
    this.announce();

    if (this.net.connected) {
      this.net.send({ t: 'done', strokes: this.strokes, result: outcome === 'sunk' ? 'sunk' : 'lost' });
      this.waitingForOthers = true;
    }

    this.onHoleComplete({
      hole: this.holeIndex,
      par: this.level.par,
      strokes: this.strokes,
      outcome,
      label,
      total: this.total + this.strokes,
    });
  }

  // ------------------------------------------------------------------- shots

  private get canShoot(): boolean {
    return this.ball?.state === 'idle' && !this.holeSettled;
  }

  private aimVector(): { dir: Vec; power: number } {
    const dx = this.aimStart.x - this.aimCur.x;
    const dy = this.aimStart.y - this.aimCur.y;
    const l = Math.hypot(dx, dy);
    if (l < 1) return { dir: { x: 1, y: 0 }, power: 0 };
    const power = clamp(l / MAX_DRAG_PX, 0, 1);
    return { dir: { x: dx / l, y: dy / l }, power };
  }

  private shoot(): void {
    const { dir, power } = this.aimVector();
    if (power < 0.03) return;
    const speed = power * MAX_SHOT_SPEED;
    this.ball.vel.x = dir.x * speed;
    this.ball.vel.y = dir.y * speed;
    this.ball.state = 'flying';
    this.ball.restingOn = -1;
    this.ball.trail.length = 0;
    this.strokes++;
    this.shotDistance = 0;
    this.shotBounces = 0;
    this.sim = makeSim();
    sfx.putt(power);
    this.particles.burst(this.ball.pos.x, this.ball.pos.y, 14, {
      hue: 195,
      speed: 70 + power * 130,
      dir: Math.atan2(-dir.y, -dir.x),
      spread: 1.4,
      size: 2,
    });
    if (this.net.connected) this.net.send({ t: 'stroke', strokes: this.strokes });
  }

  /** Banks the distance and bounces of the shot that just ended. */
  private endShot(): void {
    if (this.shotDistance <= 0) return;
    recordShot(this.stats, this.shotDistance, this.shotBounces);
    this.shotDistance = 0;
    this.shotBounces = 0;
  }

  private penalise(reason: 'lost' | 'crush' | 'adrift' | 'retry'): void {
    this.strokes++;
    if (reason !== 'retry') recordPenalty(this.stats, reason);
    const messages = {
      crush: 'Consumed by the void · +1 stroke',
      lost: 'Lost in deep space · +1 stroke',
      adrift: `Adrift for ${this.airborneTimeout}s without touching anything · +1 stroke`,
      retry: 'Hole restarted · +1 stroke',
    };
    this.flash(messages[reason]);
    const body = this.level.bodies.find((b) => b.id === this.lastRestBody);
    const p = body ? surfacePoint(body, this.lastRestAngle, BALL_RADIUS) : this.lastRest;
    this.ball.pos.x = p.x;
    this.ball.pos.y = p.y;
    this.ball.vel.x = 0;
    this.ball.vel.y = 0;
    this.ball.state = 'idle';
    this.ball.restingOn = this.lastRestBody;
    this.ball.restAngle = this.lastRestAngle;
    this.ball.trail.length = 0;
    this.sim = makeSim();
    if (this.net.connected) this.net.send({ t: 'stroke', strokes: this.strokes });
  }

  private handleEvents(events: ImpactEvent[]): void {
    for (const e of events) {
      switch (e.kind) {
        case 'bounce': {
          this.shotBounces++;
          sfx.bounce(e.strength);
          const body = this.level.bodies.find((b) => b.id === e.bodyId);
          this.particles.burst(e.pos.x, e.pos.y, 4 + Math.floor(e.strength * 12), {
            hue: body?.hue ?? 200,
            speed: 60 + e.strength * 220,
            size: 1.8,
            life: 0.45,
          });
          if (this.settings.screenShake) this.shake = Math.min(10, this.shake + e.strength * 7);
          break;
        }
        case 'stop':
          this.lastRest = { x: this.ball.pos.x, y: this.ball.pos.y };
          this.lastRestBody = this.ball.restingOn;
          this.lastRestAngle = this.ball.restAngle;
          this.endShot();
          this.announce();
          break;
        case 'sink':
          sfx.sink();
          this.particles.burst(e.pos.x, e.pos.y, 70, { hue: 150, speed: 220, size: 2.6, life: 1.1 });
          if (this.settings.screenShake) this.shake = Math.min(14, this.shake + 6);
          this.holeSettled = true;
          this.endShot();
          this.finishHole('sunk');
          break;
        case 'lost':
          sfx.lost();
          this.endShot();
          this.penalise('lost');
          break;
        case 'adrift':
          sfx.lost();
          this.endShot();
          this.penalise('adrift');
          break;
        case 'crush':
          sfx.crush();
          this.particles.burst(e.pos.x, e.pos.y, 90, { hue: 290, speed: 300, size: 3, life: 1.2 });
          if (this.settings.screenShake) this.shake = 18;
          this.endShot();
          this.penalise('crush');
          break;
      }
      if (this.holeSettled) break;
    }
    events.length = 0;
  }

  // -------------------------------------------------------------------- loop

  private frame = (now: number): void => {
    if (!this.running) return;
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.update(dt, now);
    this.draw(now / 1000);
    requestAnimationFrame(this.frame);
  };

  private update(dt: number, now: number): void {
    const events: ImpactEvent[] = [];

    if (this.ball.state === 'flying') {
      const fromX = this.ball.pos.x;
      const fromY = this.ball.pos.y;
      let remaining = dt;
      while (remaining > 0 && this.ball.state === 'flying') {
        const step = Math.min(PHYSICS_DT, remaining);
        this.time += step;
        updateBodies(this.level, this.time);
        stepBall(this.ball, this.level, step, this.sim, events);
        remaining -= step;
      }
      this.shotDistance += Math.hypot(this.ball.pos.x - fromX, this.ball.pos.y - fromY);
      this.ball.trail.push({ x: this.ball.pos.x, y: this.ball.pos.y });
      if (this.ball.trail.length > 130) this.ball.trail.shift();
      // Long flights are fine — orbits and slow transfers are the point of the game.
      // Only a ball that hasn't touched anything at all for a full minute is written off.
      if (this.sim.contactAge > this.airborneTimeout && this.ball.state === 'flying') {
        this.ball.state = 'lost';
        events.push({ kind: 'adrift', pos: { ...this.ball.pos }, strength: 1 });
      }
    } else {
      this.time += dt;
      updateBodies(this.level, this.time);
      // Ride along with an orbiting host planet instead of hanging in space.
      const host = this.level.bodies.find((b) => b.id === this.ball.restingOn);
      if (host && this.ball.state === 'idle') {
        const p = surfacePoint(host, this.ball.restAngle, BALL_RADIUS);
        this.ball.pos.x = p.x;
        this.ball.pos.y = p.y;
      }
      if (this.ball.trail.length) this.ball.trail.shift();
    }

    this.handleEvents(events);

    // Play time is batched and only written to storage on hole boundaries.
    this.unsavedPlayTime += dt;

    this.particles.update(dt);
    this.field.update(this.level.bodies, this.cam, dt);
    this.shake = damp(this.shake, 0, 6, dt);

    for (const g of this.ghosts.values()) {
      g.render.x = damp(g.render.x, g.target.x, 12, dt);
      g.render.y = damp(g.render.y, g.target.y, 12, dt);
    }

    this.updateCamera();
    this.cam.update(dt);

    if (this.net.connected) this.net.sendPos(this.ball.pos.x, this.ball.pos.y, this.ball.state, now);
  }

  /** Ball + cup, plus the two planets they sit on, so nothing important is cropped. */
  private framePoints(holePos: Vec): (Vec & { r?: number })[] {
    const pts: (Vec & { r?: number })[] = [{ ...this.ball.pos }, { ...holePos }];
    const cupBody = this.level.bodies[this.level.holeBody];
    pts.push({ x: cupBody.pos.x, y: cupBody.pos.y, r: cupBody.radius * 1.25 });
    const host = this.level.bodies.find((b) => b.id === this.ball.restingOn);
    if (host) pts.push({ x: host.pos.x, y: host.pos.y, r: host.radius * 1.25 });
    return pts;
  }

  private updateCamera(): void {
    // Freeze the view while aiming — drifting the camera mid-drag moves the target
    // under the player's cursor and can push the cup off screen.
    if (!this.cam.auto || this.aiming) return;
    const hole = this.level.bodies[this.level.holeBody];
    const holePos = surfacePoint(hole, this.level.holeAngle);

    if (this.ball.state === 'flying') {
      const speed = Math.hypot(this.ball.vel.x, this.ball.vel.y);
      this.cam.targetPos.x = this.ball.pos.x + this.ball.vel.x * 0.28;
      this.cam.targetPos.y = this.ball.pos.y + this.ball.vel.y * 0.28;
      // Zoom out as the ball speeds up so fast shots stay readable.
      this.cam.targetZoom = clamp(0.9 - speed / 1500, 0.22, 0.95);
    } else {
      this.cam.frame(this.framePoints(holePos), 300, 0.75);
    }
  }

  // ------------------------------------------------------------------ render

  private draw(timeSec: number): void {
    const ctx = this.ctx;
    const dpr = Math.min(window.devicePixelRatio || 1, this.settings.quality === 0 ? 1 : 2);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.cam.resize(w, h);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.shake > 0.2) {
      ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
    }

    ctx.fillStyle = '#04060f';
    ctx.fillRect(-20, -20, w + 40, h + 40);

    this.starfield.draw(ctx, this.cam, timeSec, this.settings.quality);
    this.field.draw(ctx, this.cam, this.level.bodies, this.settings.gravityIntensity);

    if (this.settings.showOrbits) {
      for (const b of this.level.bodies) drawOrbitPath(ctx, this.cam, b);
    }

    this.drawWorldBounds(ctx);

    for (const b of this.level.bodies) {
      if (this.cam.visible(b.pos, b.radius * 4)) drawBody(ctx, this.cam, b, timeSec);
    }

    drawHole(ctx, this.cam, this.level, timeSec);
    this.particles.draw(ctx, this.cam);

    for (const g of this.ghosts.values()) {
      if (g.info.id === this.net.selfId) continue;
      const view: GhostView = {
        id: g.info.id,
        name: g.info.name,
        hue: g.info.hue,
        x: g.render.x,
        y: g.render.y,
        state: g.info.state,
        strokes: g.info.strokes,
      };
      drawGhost(ctx, this.cam, view, this.settings.showGhostNames);
    }

    if (this.settings.showTrail) drawTrail(ctx, this.cam, this.ball.trail);
    drawBall(ctx, this.cam, this.ball, timeSec);

    if (this.aiming && this.canShoot) this.drawAimGuide(ctx, timeSec);

    const holePos = surfacePoint(this.level.bodies[this.level.holeBody], this.level.holeAngle);
    drawOffscreenMarker(ctx, this.cam, holePos, 'rgba(120, 255, 190, 0.9)', 'CUP');
    if (this.ball.state === 'flying') {
      drawOffscreenMarker(ctx, this.cam, this.ball.pos, 'rgba(190, 235, 255, 0.9)', 'BALL');
    }

    this.drawStatus(ctx, w, h);
  }

  private drawWorldBounds(ctx: CanvasRenderingContext2D): void {
    const r = this.level.worldRadius * this.cam.zoom;
    const c = this.cam.worldToScreen({ x: 0, y: 0 });
    ctx.save();
    ctx.setLineDash([10, 14]);
    ctx.strokeStyle = 'rgba(255, 130, 90, 0.22)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private drawAimGuide(ctx: CanvasRenderingContext2D, timeSec: number): void {
    const { dir, power } = this.aimVector();
    if (power <= 0) return;
    const speed = power * MAX_SHOT_SPEED;
    const seconds = this.settings.aimAssist;
    let points: Vec[] = [];
    let outcome = 'open';
    if (seconds > 0) {
      const r = predictTrajectory(
        this.level,
        this.ball.pos,
        { x: dir.x * speed, y: dir.y * speed },
        seconds,
        this.time,
      );
      points = r.points;
      outcome = r.outcome;
    }
    drawAim(ctx, this.cam, this.ball.pos, points, outcome, power, dir, timeSec);
  }

  private drawStatus(ctx: CanvasRenderingContext2D, w: number, _h: number): void {
    const now = performance.now();
    let text = '';
    if (this.countdown > now) {
      text = `Next hole in ${Math.ceil((this.countdown - now) / 1000)}…`;
    } else if (this.waitingForOthers) {
      text = 'Waiting for other players…';
    } else if (now < this.statusUntil) {
      text = this.statusMessage;
    }
    if (!text) return;
    ctx.save();
    ctx.font = '600 15px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    const width = ctx.measureText(text).width + 34;
    // Top-centre keeps this clear of the hint bar and the DOM toast at the bottom.
    const y = 52;
    ctx.fillStyle = 'rgba(8, 12, 24, 0.72)';
    ctx.beginPath();
    ctx.roundRect(w / 2 - width / 2, y - 22, width, 34, 17);
    ctx.fill();
    ctx.strokeStyle = 'rgba(140, 200, 255, 0.25)';
    ctx.stroke();
    ctx.fillStyle = 'rgba(226, 238, 255, 0.95)';
    ctx.fillText(text, w / 2, y);
    ctx.restore();
  }

  flash(message: string, ms = 2600): void {
    this.statusMessage = message;
    this.statusUntil = performance.now() + ms;
  }

  // ------------------------------------------------------------------- input

  private bindInput(): void {
    const c = this.canvas;
    c.style.touchAction = 'none';

    c.addEventListener('pointerdown', (e) => {
      sfx.unlock();
      c.setPointerCapture(e.pointerId);
      const p = this.localPoint(e);
      this.pointers.set(e.pointerId, p);

      if (this.pointers.size === 2) {
        this.aiming = false;
        const [a, b] = [...this.pointers.values()];
        this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
        return;
      }

      if (e.button === 2 || e.button === 1 || e.shiftKey) {
        this.panning = true;
        this.panLast = p;
        this.cam.auto = false;
        return;
      }

      if (this.canShoot) {
        this.aiming = true;
        // Always slingshot from the ball itself so aim is unambiguous at any zoom.
        this.aimStart = this.cam.worldToScreen(this.ball.pos);
        this.aimCur = p;
      } else {
        this.panning = true;
        this.panLast = p;
        this.cam.auto = false;
      }
    });

    c.addEventListener('pointermove', (e) => {
      const p = this.localPoint(e);
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, p);

      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinchDist > 0) {
          this.cam.auto = false;
          this.cam.zoomAt(d / this.pinchDist, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        }
        this.pinchDist = d;
        return;
      }

      if (this.panning) {
        this.cam.targetPos.x -= (p.x - this.panLast.x) / this.cam.zoom;
        this.cam.targetPos.y -= (p.y - this.panLast.y) / this.cam.zoom;
        this.cam.pos.x = this.cam.targetPos.x;
        this.cam.pos.y = this.cam.targetPos.y;
        this.panLast = p;
        return;
      }

      if (this.aiming) {
        this.aimStart = this.cam.worldToScreen(this.ball.pos);
        this.aimCur = p;
      }
    });

    const endPointer = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinchDist = 0;
      if (this.panning) {
        this.panning = false;
        return;
      }
      if (this.aiming) {
        this.aiming = false;
        if (this.canShoot) this.shoot();
      }
    };
    c.addEventListener('pointerup', endPointer);
    c.addEventListener('pointercancel', endPointer);
    c.addEventListener('contextmenu', (e) => e.preventDefault());

    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.cam.auto = false;
        this.cam.zoomAt(Math.exp(-e.deltaY * 0.0016), this.localPoint(e));
      },
      { passive: false },
    );
  }

  private localPoint(e: { clientX: number; clientY: number }): Vec {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** Fits the whole course in view. */
  viewAll(): void {
    this.cam.auto = false;
    this.cam.frame(
      this.level.bodies.map((b) => ({ x: b.pos.x, y: b.pos.y, r: b.radius })),
      500,
      MAX_ZOOM,
    );
  }

  recenter(): void {
    this.cam.auto = this.settings.autoCamera;
    const holePos = surfacePoint(this.level.bodies[this.level.holeBody], this.level.holeAngle);
    this.cam.frame([this.ball.pos, holePos], 340, 0.75);
  }

  zoomBy(factor: number): void {
    this.cam.auto = false;
    this.cam.zoomAt(factor, { x: this.cam.viewW / 2, y: this.cam.viewH / 2 });
  }

  // ------------------------------------------------------------- multiplayer

  private syncGhosts(): void {
    const seen = new Set<string>();
    for (const info of this.players) {
      seen.add(info.id);
      const existing = this.ghosts.get(info.id);
      if (existing) {
        existing.info = info;
      } else {
        this.ghosts.set(info.id, {
          info,
          target: { x: this.ball?.pos.x ?? 0, y: this.ball?.pos.y ?? 0 },
          render: { x: this.ball?.pos.x ?? 0, y: this.ball?.pos.y ?? 0 },
          seen: performance.now(),
        });
      }
    }
    for (const id of [...this.ghosts.keys()]) {
      if (!seen.has(id)) this.ghosts.delete(id);
    }
  }

  // Exposed for the automated browser smoke test (scripts/browser-smoke.js).
  get __aiming(): boolean {
    return this.aiming;
  }

  get __sim(): SimState {
    return this.sim;
  }

  readonly __surfacePoint = surfacePoint;

  hud(): HudState {
    return {
      hole: this.holeIndex,
      par: this.level?.par ?? 3,
      strokes: this.strokes,
      tier: this.level?.tier ?? 'Easy',
      total: this.total,
      bodies: this.level?.bodies.length ?? 0,
      status: this.statusMessage,
      zoom: this.cam.zoom,
      canShoot: this.canShoot,
      netStatus: this.net.status,
      room: this.net.room,
      waiting: this.waitingForOthers,
    };
  }
}
