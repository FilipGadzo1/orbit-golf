# Polish & Progression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first post-launch update — ambient music, colorblind mode, and a cosmetics system driven by a skill-earned local currency — without touching generation, physics, or multiplayer advancement.

**Architecture:** Every feature is additive and isolated. Music is a new self-contained WebAudio class in `audio/`. Colorblind mode is a display-only branch in the aim-guide render path gated by a new setting. Cosmetics live in a new independent localStorage module (`game/cosmetics.ts`) mirroring the existing `stats.ts`/`settings.ts`/`friends.ts` pattern; earning hooks the existing `onHoleComplete` callback; rendering reads the equipped skin; and the equipped skin id rides along as one new static field on `PresenceMeta` so other clients can style your ghost, with a safe fallback when absent.

**Tech Stack:** TypeScript (strict, `noUnusedLocals`/`noUnusedParameters`), Vite, Canvas 2D immediate-mode rendering, WebAudio, Supabase Realtime (Presence/Broadcast), esbuild-bundled headless Node tests.

## Global Constraints

- **No `Math.random()` in generation** and **no changes to** `src/game/generator.ts`, `src/game/physics.ts`, or the hole-advancement logic in `src/net/realtime.ts`. This update must not alter course output or the determinism contract.
- **No new assets.** All audio is runtime-synthesized; all skins are code-defined (colors/gradients). Nothing is fetched or bundled as a file.
- **Currency is local-only** — a new localStorage module, no server, no Supabase table.
- **Each localStorage module keeps its own key and its own `load`/`save` pair.** Nothing outside a module touches its key.
- **Backwards-compatible persistence:** every new persisted field must default cleanly so existing saved `settings`/`stats` blobs still load (spread-over-defaults pattern already in use).
- **Presence additions must be a single static field** defaulted in `blankMeta()`, never added to `RoomMeta` or the `pos` broadcast hot path.
- TypeScript is strict: no unused imports or params, or `npm run build` fails.
- Run `npm test` (headless suites) and `npm run build` before considering any task done; run `npm run test:e2e` before the final wrap-up.

---

### Task 1: Ambient music module

**Files:**
- Create: `src/audio/music.ts`
- Modify: `src/game/settings.ts` (add `musicVolume` field + default)
- Modify: `src/main.ts` (instantiate, unlock on first gesture, wire settings slider)
- Modify: `index.html` (music volume slider in the settings panel)

**Interfaces:**
- Produces: `class Music { unlock(): void; setVolume(v: number): void; start(): void; stop(): void }` and singleton `export const music = new Music()`.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Create the music module**

Create `src/audio/music.ts`. It mirrors the self-contained, asset-free style of `src/audio/sfx.ts`: a suspended `AudioContext` until `unlock()`, a master gain set from `volume`, and a slow scheduled chord/arpeggio loop driven by `setInterval` while playing.

```typescript
/**
 * Generative ambient bed, synthesised at runtime like sfx.ts — no audio files.
 * A slow chord pad plus an occasional arpeggio note, scheduled on a timer while playing.
 */
export class Music {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private step = 0;
  volume = 0.35;
  private playing = false;

  /** Safe to call repeatedly; only resumes inside a user gesture. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
    if (v <= 0) this.stop();
    else if (!this.playing) this.start();
  }

  start(): void {
    if (this.playing || this.volume <= 0) return;
    this.unlock();
    if (!this.ctx) return;
    this.playing = true;
    this.tick();
    // A note every ~2.2s keeps the bed sparse and non-distracting.
    this.timer = setInterval(() => this.tick(), 2200);
  }

  stop(): void {
    this.playing = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One scheduled voice: a soft sine held for a few seconds, drifting through a scale. */
  private tick(): void {
    if (!this.ctx || !this.master) return;
    // A minor pentatonic-ish set, low and calm.
    const scale = [110, 130.81, 146.83, 164.81, 196, 220];
    const root = scale[this.step % scale.length];
    this.step++;
    this.voice(root, 4.5, 0.05);
    // A fifth above, quieter, on every other step for movement.
    if (this.step % 2 === 0) this.voice(root * 1.5, 3.5, 0.03);
  }

  private voice(freq: number, dur: number, gain: number): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.8);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }
}

export const music = new Music();
```

- [ ] **Step 2: Add the setting**

In `src/game/settings.ts`, add `musicVolume: number;` to the `Settings` interface (after `volume`) and `musicVolume: 0.35,` to `DEFAULTS`. Because `loadSettings` does `{ ...DEFAULTS, ...stored }`, existing saved blobs without the field get the default automatically.

- [ ] **Step 3: Add the slider markup**

In `index.html`, inside the settings panel next to the existing volume/sound controls, add:

```html
<label class="setting">
  <span>Music</span>
  <input id="set-music" type="range" min="0" max="1" step="0.05" />
</label>
```

- [ ] **Step 4: Wire it in main.ts**

In `src/main.ts`, import the singleton alongside the existing sfx import:

```typescript
import { music } from './audio/music';
```

Wherever the code already calls `sfx.unlock()` on the first user gesture (search for `sfx.unlock`), add `music.unlock();` and, if `settings.musicVolume > 0`, `music.start();` right after. Where the settings panel initialises its inputs from `settings`, set `$<HTMLInputElement>('set-music').value = String(settings.musicVolume);` and add a listener:

```typescript
$<HTMLInputElement>('set-music').addEventListener('input', (e) => {
  settings.musicVolume = Number((e.target as HTMLInputElement).value);
  music.setVolume(settings.musicVolume);
  saveSettings(settings);
});
```

Match the exact `$`, `settings`, and `saveSettings` identifiers already used in `main.ts` for the neighbouring volume control.

- [ ] **Step 5: Verify build + manual smoke**

Run: `npm run build`
Expected: PASS (no unused-symbol errors; `music` is referenced).

Run: `npm run dev`, open the app, interact once, confirm ambient tones start and the Music slider changes/stops them. (Audio can't be asserted headlessly; this is a manual check.)

- [ ] **Step 6: Commit**

```bash
git add src/audio/music.ts src/game/settings.ts src/main.ts index.html
git commit -m "feat(audio): add runtime-synthesised ambient music with its own volume"
```

---

### Task 2: Colorblind mode for the aim guide

**Files:**
- Modify: `src/game/settings.ts` (add `colorblind` boolean + default)
- Modify: `src/render/renderer.ts` (alternate outcome palette + end-of-line label in `drawAim`)
- Modify: `src/game/game.ts` (pass the setting into the aim draw call)
- Modify: `index.html` (colorblind toggle)
- Modify: `src/main.ts` (wire the toggle)

**Interfaces:**
- Consumes: `Settings.colorblind` (this task).
- Produces: `drawAim(..., colorblind: boolean)` — one new trailing param on the existing exported `drawAim`.

- [ ] **Step 1: Add the setting**

In `src/game/settings.ts`: add `colorblind: boolean;` to `Settings` and `colorblind: false,` to `DEFAULTS`.

- [ ] **Step 2: Add the accessible palette + label to renderer**

In `src/render/renderer.ts`, add a second palette and a label map beside the existing `OUTCOME_COLOR` (around line 16):

```typescript
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
```

Change the `drawAim` signature to accept the flag (append it — callers updated in Step 3):

```typescript
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
```

Replace the former `const base = OUTCOME_COLOR[outcome] ?? OUTCOME_COLOR.open;` line with the two lines above. Then, at the end of `drawAim`, when `colorblind` is true and `points.length` is non-zero, draw the label at the last point:

```typescript
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
```

- [ ] **Step 3: Pass the flag from the game**

In `src/game/game.ts`, find the `drawAim(` call inside `drawAimGuide` (near the aim-guide draw) and append `, this.settings.colorblind` as the final argument. The `Game` already holds `this.settings`, so no new wiring is needed.

- [ ] **Step 4: Add the toggle markup**

In `index.html`, in the settings panel add:

```html
<label class="setting">
  <span>Colorblind aim labels</span>
  <input id="set-colorblind" type="checkbox" />
</label>
```

- [ ] **Step 5: Wire the toggle in main.ts**

In `src/main.ts`, where other settings checkboxes are initialised/handled (e.g. `set-orbits`/`showOrbits`), add:

```typescript
$<HTMLInputElement>('set-colorblind').checked = settings.colorblind;
$<HTMLInputElement>('set-colorblind').addEventListener('change', (e) => {
  settings.colorblind = (e.target as HTMLInputElement).checked;
  saveSettings(settings);
});
```

- [ ] **Step 6: Build + verify**

Run: `npm run build`
Expected: PASS. (`noUnusedParameters` means the new `colorblind` param must be used — it is, in Step 2.)

Manual: `npm run dev`, aim a shot, toggle the setting, confirm palette swaps and labels appear.

- [ ] **Step 7: Commit**

```bash
git add src/game/settings.ts src/render/renderer.ts src/game/game.ts index.html src/main.ts
git commit -m "feat(a11y): colorblind aim-guide palette and outcome labels"
```

---

### Task 3: Cosmetics module — currency, skins, persistence (+ headless tests)

**Files:**
- Create: `src/game/cosmetics.ts`
- Create: `test/cosmetics.ts`
- Modify: `scripts/run-tests.js` (register the new suite)

**Interfaces:**
- Produces:
  - `interface Cosmetics { version: number; balance: number; owned: string[]; equipped: string }`
  - `interface Skin { id: string; name: string; price: number; body: [string, string]; glow: string; accent: string }`
  - `const SKINS: Skin[]` (first entry is the free default `'classic'`)
  - `loadCosmetics(): Cosmetics`, `saveCosmetics(c: Cosmetics): void`, `resetCosmetics(): Cosmetics`
  - `awardFor(r: { strokes: number; par: number; outcome: 'sunk' | 'lost' }): number`
  - `grant(c: Cosmetics, amount: number): void`
  - `buy(c: Cosmetics, id: string): boolean` (false if unknown/owned/too poor)
  - `equip(c: Cosmetics, id: string): boolean` (false if not owned)
  - `skinById(id: string): Skin`
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

Create `test/cosmetics.ts`. Reuse the localStorage shim + `check` harness pattern from `test/stats.ts`:

```typescript
/** Headless checks for the cosmetics currency + shop. localStorage is shimmed in-memory. */
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
} as Storage;

const { SKINS, loadCosmetics, saveCosmetics, resetCosmetics, awardFor, grant, buy, equip, skinById } =
  await import('../src/game/cosmetics');

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) {
    failures++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('Orbit Golf — cosmetics checks\n');

// --- award math -------------------------------------------------------------
check('ace pays most', awardFor({ strokes: 1, par: 3, outcome: 'sunk' }) === 10 + 50 + 25);
check('par pays base+par', awardFor({ strokes: 3, par: 3, outcome: 'sunk' }) === 10 + 10);
check('birdie', awardFor({ strokes: 2, par: 3, outcome: 'sunk' }) === 10 + 20);
check('bogey small', awardFor({ strokes: 4, par: 3, outcome: 'sunk' }) === 10 + 5);
check('double bogey base only', awardFor({ strokes: 5, par: 3, outcome: 'sunk' }) === 10);
check('conceded consolation', awardFor({ strokes: 6, par: 3, outcome: 'lost' }) === 2);

// --- catalog + defaults -----------------------------------------------------
{
  const c = resetCosmetics();
  check('default owns classic', c.owned.includes('classic') && c.equipped === 'classic');
  check('classic is free & first', SKINS[0].id === 'classic' && SKINS[0].price === 0);
  check('fresh balance zero', c.balance === 0);
}

// --- buy / equip flow -------------------------------------------------------
{
  const c = resetCosmetics();
  const paid = SKINS.find((s) => s.price > 0)!;
  check('cannot buy when broke', buy(c, paid.id) === false && !c.owned.includes(paid.id));
  grant(c, paid.price);
  check('buy succeeds when funded', buy(c, paid.id) === true && c.owned.includes(paid.id));
  check('balance deducted', c.balance === 0);
  check('cannot rebuy', buy(c, paid.id) === false);
  check('equip owned', equip(c, paid.id) === true && c.equipped === paid.id);
  check('cannot equip unowned', equip(c, 'no-such-skin') === false && c.equipped === paid.id);
  check('unknown id buy fails', buy(c, 'no-such-skin') === false);
}

// --- persistence + migration ------------------------------------------------
{
  const c = resetCosmetics();
  grant(c, 123);
  saveCosmetics(c);
  const again = loadCosmetics();
  check('balance persists', again.balance === 123);
  check('equipped persists', again.equipped === 'classic');

  store.clear();
  const blank = loadCosmetics();
  check('blank load owns classic', blank.owned.includes('classic') && blank.equipped === 'classic');
  check('skinById falls back to classic', skinById('missing').id === 'classic');
}

console.log(failures === 0 ? '\nAll cosmetics checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Register the suite and run it to confirm it fails**

In `scripts/run-tests.js`, change `const suites = ['smoke', 'stats', 'multiplayer'];` to `const suites = ['smoke', 'stats', 'multiplayer', 'cosmetics'];`.

Run: `npm test`
Expected: FAIL — the `cosmetics` suite errors because `../src/game/cosmetics` does not exist yet.

- [ ] **Step 3: Write the cosmetics module**

Create `src/game/cosmetics.ts`:

```typescript
/**
 * Cosmetics + local currency ("Stardust"). An independent localStorage module, same
 * shape as stats.ts / settings.ts / friends.ts — its own key and load/save. Currency is
 * device-local (no server), so there is nothing to cheat but your own wallet.
 */
export interface Skin {
  id: string;
  name: string;
  /** Stardust price. The default skin is 0 and owned from the start. */
  price: number;
  /** Ball body radial-gradient stops: [inner, outer]. */
  body: [string, string];
  /** Outer glow colour (rgba string). */
  glow: string;
  /** Accent used for the ghost ring so others can tell your skin apart. */
  accent: string;
}

/** First entry is the free default and reproduces the original ball look exactly. */
export const SKINS: Skin[] = [
  { id: 'classic', name: 'Classic', price: 0, body: ['#ffffff', '#9fc4e8'], glow: 'rgba(190, 235, 255, 0.5)', accent: 'hsla(205, 100%, 82%, 0.95)' },
  { id: 'ember', name: 'Ember', price: 150, body: ['#fff2d6', '#e8863f'], glow: 'rgba(255, 190, 120, 0.5)', accent: 'hsla(28, 100%, 70%, 0.95)' },
  { id: 'aurora', name: 'Aurora', price: 350, body: ['#eafff4', '#39e0a5'], glow: 'rgba(120, 255, 200, 0.5)', accent: 'hsla(160, 90%, 70%, 0.95)' },
  { id: 'nova', name: 'Nova', price: 700, body: ['#fbe9ff', '#b45cff'], glow: 'rgba(210, 150, 255, 0.5)', accent: 'hsla(280, 100%, 78%, 0.95)' },
  { id: 'gold', name: 'Champion Gold', price: 1500, body: ['#fff7e0', '#f2c14e'], glow: 'rgba(255, 220, 130, 0.55)', accent: 'hsla(45, 100%, 68%, 0.98)' },
];

export interface Cosmetics {
  version: number;
  balance: number;
  owned: string[];
  equipped: string;
}

const KEY = 'orbit-golf.cosmetics.v1';
const DEFAULT_ID = 'classic';

function empty(): Cosmetics {
  return { version: 1, balance: 0, owned: [DEFAULT_ID], equipped: DEFAULT_ID };
}

export function loadCosmetics(): Cosmetics {
  let stored: Partial<Cosmetics> = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Cosmetics>;
  } catch {
    stored = {};
  }
  const c = { ...empty(), ...stored };
  // Repair invariants: classic always owned, equipped must be owned & real.
  if (!c.owned.includes(DEFAULT_ID)) c.owned = [DEFAULT_ID, ...c.owned];
  c.owned = c.owned.filter((id) => SKINS.some((s) => s.id === id));
  if (!c.owned.includes(c.equipped)) c.equipped = DEFAULT_ID;
  return c;
}

export function saveCosmetics(c: Cosmetics): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* private mode — cosmetics just won't persist */
  }
}

export function resetCosmetics(): Cosmetics {
  const fresh = empty();
  saveCosmetics(fresh);
  return fresh;
}

export function skinById(id: string): Skin {
  return SKINS.find((s) => s.id === id) ?? SKINS[0];
}

/** Stardust awarded for a completed hole. Pure and generous; no anti-farm needed. */
export function awardFor(r: { strokes: number; par: number; outcome: 'sunk' | 'lost' }): number {
  if (r.outcome !== 'sunk') return 2;
  const base = 10;
  const rel = r.strokes - r.par;
  const bonus = rel <= -3 ? 50 : rel === -2 ? 30 : rel === -1 ? 20 : rel === 0 ? 10 : rel === 1 ? 5 : 0;
  const ace = r.strokes === 1 ? 25 : 0;
  return base + bonus + ace;
}

export function grant(c: Cosmetics, amount: number): void {
  c.balance = Math.max(0, c.balance + Math.round(amount));
}

export function buy(c: Cosmetics, id: string): boolean {
  const skin = SKINS.find((s) => s.id === id);
  if (!skin || c.owned.includes(id) || c.balance < skin.price) return false;
  c.balance -= skin.price;
  c.owned.push(id);
  return true;
}

export function equip(c: Cosmetics, id: string): boolean {
  if (!c.owned.includes(id)) return false;
  c.equipped = id;
  return true;
}
```

- [ ] **Step 4: Run the suite to confirm it passes**

Run: `npm test`
Expected: PASS — all suites including `cosmetics` green.

- [ ] **Step 5: Commit**

```bash
git add src/game/cosmetics.ts test/cosmetics.ts scripts/run-tests.js
git commit -m "feat(cosmetics): currency + skin catalog module with headless tests"
```

---

### Task 4: Earn currency on hole completion + award toast

**Files:**
- Modify: `src/main.ts` (load cosmetics, grant on `onHoleComplete`, show a toast, expose balance to the shop later)

**Interfaces:**
- Consumes: `loadCosmetics`, `saveCosmetics`, `awardFor`, `grant`, `Cosmetics` from Task 3; the existing `game.onHoleComplete = (r) => { ... }` (main.ts:194) whose `r` is `HoleResult { hole, par, strokes, outcome, label, total }`; the existing achievement-toast helper used by `game.onAchievements` (main.ts:695).
- Produces: a module-level `cosmetics: Cosmetics` in `main.ts` that Task 5 (shop) and Task 6 (render) read.

- [ ] **Step 1: Load cosmetics at startup**

In `src/main.ts`, near where `settings`/`stats` are loaded, add:

```typescript
import { loadCosmetics, saveCosmetics, awardFor, grant } from './game/cosmetics';
// ...
const cosmetics = loadCosmetics();
```

- [ ] **Step 2: Grant on hole completion**

Inside the existing `game.onHoleComplete = (r) => { ... }` (main.ts:194), before the `setTimeout`, add:

```typescript
if (r.outcome === 'sunk' || r.outcome === 'lost') {
  const reward = awardFor({ strokes: r.strokes, par: r.par, outcome: r.outcome });
  grant(cosmetics, reward);
  saveCosmetics(cosmetics);
  showStardustToast(reward);
}
```

(`HoleResult.outcome` is `'sunk' | 'lost'`; the guard is defensive.)

- [ ] **Step 3: Add the toast helper**

Reuse the existing toast mechanism. Find how `game.onAchievements` (main.ts:695) renders a toast — it appends a node to a toast container. Add a sibling helper that matches that DOM pattern. Concretely, if achievements build an element and append it to a container like `$('toasts')`, mirror it:

```typescript
function showStardustToast(amount: number): void {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'toast stardust';
  el.textContent = `✦ +${amount} Stardust`;
  host.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
```

If the achievement toast uses a different container id or class, use those exact names instead so styling and teardown are consistent. Add a small CSS rule for `.toast.stardust` in `src/styles.css` if achievements rely on per-type classes.

- [ ] **Step 4: Build + verify**

Run: `npm run build`
Expected: PASS (`cosmetics`, `awardFor`, `grant`, `saveCosmetics` all referenced).

Manual: `npm run dev`, sink a hole, confirm a "+N Stardust" toast appears and the amount scales with performance (ace pays more than a bogey).

- [ ] **Step 5: Commit**

```bash
git add src/main.ts src/styles.css
git commit -m "feat(cosmetics): award Stardust on hole completion with a toast"
```

---

### Task 5: Shop UI — browse, buy, equip

**Files:**
- Modify: `index.html` (shop panel/screen markup + an entry button)
- Modify: `src/main.ts` (render the shop from `SKINS` + `cosmetics`, handle buy/equip, open/close)
- Modify: `src/styles.css` (shop list styling)

**Interfaces:**
- Consumes: `SKINS`, `buy`, `equip`, `skinById`, `saveCosmetics`, and the module-level `cosmetics` from Tasks 3–4; the existing screen-management helpers in `main.ts` (`openScreen`, `$`, `show`) and `sfx.ui()`.
- Produces: `renderShop(): void` in `main.ts`, called on open and after each buy/equip.

- [ ] **Step 1: Add the shop markup**

In `index.html`, add a screen/panel consistent with existing ones (e.g. the stats sheet `T`). Give it a balance readout, a list container, and a close button:

```html
<section id="shop" class="screen" hidden>
  <div class="panel">
    <header class="panel-head">
      <h2>Cosmetics Shop</h2>
      <span id="shop-balance" class="balance">✦ 0</span>
    </header>
    <div id="shop-list" class="shop-list"></div>
    <footer><button id="shop-close" class="btn">Close</button></footer>
  </div>
</section>
```

Add an entry button in the settings panel (or HUD) alongside the career-stats entry:

```html
<button id="btn-shop" class="btn">Cosmetics shop</button>
```

- [ ] **Step 2: Render the shop in main.ts**

In `src/main.ts` add:

```typescript
import { SKINS, buy, equip, skinById } from './game/cosmetics';

function renderShop(): void {
  $('shop-balance').textContent = `✦ ${cosmetics.balance}`;
  const list = $('shop-list');
  list.innerHTML = '';
  for (const skin of SKINS) {
    const owned = cosmetics.owned.includes(skin.id);
    const equipped = cosmetics.equipped === skin.id;
    const row = document.createElement('div');
    row.className = 'shop-row';
    const swatch = document.createElement('span');
    swatch.className = 'shop-swatch';
    swatch.style.background = `radial-gradient(circle at 35% 35%, ${skin.body[0]}, ${skin.body[1]})`;
    const label = document.createElement('span');
    label.className = 'shop-name';
    label.textContent = skin.name;
    const action = document.createElement('button');
    action.className = 'btn';
    if (equipped) {
      action.textContent = 'Equipped';
      action.disabled = true;
    } else if (owned) {
      action.textContent = 'Equip';
      action.addEventListener('click', () => {
        equip(cosmetics, skin.id);
        saveCosmetics(cosmetics);
        game.net.setSkin(cosmetics.equipped); // no-op offline; wired in Task 7
        sfx.ui();
        renderShop();
      });
    } else {
      action.textContent = `Buy ✦${skin.price}`;
      action.disabled = cosmetics.balance < skin.price;
      action.addEventListener('click', () => {
        if (buy(cosmetics, skin.id)) {
          saveCosmetics(cosmetics);
          sfx.ui();
          renderShop();
        }
      });
    }
    row.append(swatch, label, action);
    list.appendChild(row);
  }
}

$('btn-shop').addEventListener('click', () => {
  sfx.ui();
  renderShop();
  openScreen('shop');
});
$('shop-close').addEventListener('click', () => {
  sfx.ui();
  openScreen('game');
});
```

> Note: `game.net.setSkin(...)` is added in Task 7. To keep this task independently buildable, add a temporary no-op `setSkin(_id: string): void {}` stub on `RealtimeClient` now (Task 7 replaces its body). Reference `skinById` where you preview the equipped skin if you add a "current" swatch; otherwise drop the `skinById` import to satisfy `noUnusedLocals`.

- [ ] **Step 3: Style the shop**

In `src/styles.css`, add rules for `.shop-list`, `.shop-row`, `.shop-swatch` (a ~28px circle), `.shop-name`, and `.balance`, matching the existing panel visual language (reuse variables/classes already present).

- [ ] **Step 4: Build + verify**

Run: `npm run build`
Expected: PASS.

Manual: `npm run dev`, open the shop, confirm: buy is disabled when broke, enabling after earning; buying deducts balance; equip switches the "Equipped" marker.

- [ ] **Step 5: Commit**

```bash
git add index.html src/main.ts src/styles.css
git commit -m "feat(cosmetics): shop UI to browse, buy, and equip skins"
```

---

### Task 6: Render the equipped skin on your ball

**Files:**
- Modify: `src/render/renderer.ts` (`drawBall` takes a skin style)
- Modify: `src/game/game.ts` (pass the equipped skin into `drawBall`)

**Interfaces:**
- Consumes: `Skin`/`skinById` from Task 3; `cosmetics.equipped` (threaded via `Game`).
- Produces: `drawBall(ctx, cam, ball, time, skin)` where `skin: { body: [string, string]; glow: string }`.

- [ ] **Step 1: Parametrize drawBall**

In `src/render/renderer.ts`, change `drawBall` to accept a skin style and use it in place of the hardcoded colours:

```typescript
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
  // ...leave the existing "sunk" ring block below unchanged...
```

Keep the rest of the function (the `ball.state === 'sunk'` ring) exactly as-is. The default `classic` skin values reproduce the original look, so nothing changes visually unless a skin is equipped.

- [ ] **Step 2: Thread the skin through Game**

`Game` needs the equipped skin. Add a public field on `Game` (in `src/game/game.ts`, near the other public callback/settings fields around line 134):

```typescript
/** Skin style for the local ball; set by main.ts from the cosmetics module. */
ballSkin: { body: [string, string]; glow: string } = { body: ['#ffffff', '#9fc4e8'], glow: 'rgba(190, 235, 255, 0.5)' };
```

At the `drawBall` call (game.ts:656) change it to:

```typescript
drawBall(ctx, this.cam, this.ball, timeSec, this.ballSkin);
```

- [ ] **Step 3: Set the skin from main.ts**

In `src/main.ts`, import `skinById` (if not already) and set the ball skin whenever it changes — at startup and after equipping in the shop:

```typescript
function applyEquippedSkin(): void {
  const sk = skinById(cosmetics.equipped);
  game.ballSkin = { body: sk.body, glow: sk.glow };
}
```

Call `applyEquippedSkin()` once after `const cosmetics = loadCosmetics();`, and again inside the shop's equip handler (Task 5, Step 2) right after `saveCosmetics(cosmetics)`.

- [ ] **Step 4: Build + verify**

Run: `npm run build`
Expected: PASS.

Manual: `npm run dev`, equip a non-classic skin, confirm your ball's body + glow change; equip Classic, confirm the original look returns.

- [ ] **Step 5: Commit**

```bash
git add src/render/renderer.ts src/game/game.ts src/main.ts
git commit -m "feat(cosmetics): render the equipped skin on the local ball"
```

---

### Task 7: Broadcast the equipped skin over Presence (multiplayer ghosts)

**Files:**
- Modify: `src/net/protocol.ts` (add `skin` to `PresenceMeta` and `PlayerInfo`)
- Modify: `src/net/realtime.ts` (`blankMeta` default, `connect` param, `setSkin`, `players()` mapping)
- Modify: `src/game/game.ts` (thread skin into `GhostView`; expose `net.setSkin`)
- Modify: `src/render/renderer.ts` (`drawGhost` uses the skin accent when present)
- Modify: `src/main.ts` (pass equipped skin into `connect`; real `setSkin` call already added in Task 5)
- Modify: `test/multiplayer.ts` (assert skin propagation + absent-field fallback)

**Interfaces:**
- Consumes: `PresenceMeta` (protocol), `players()`/`connect` (realtime), `GhostView` (renderer), `skinById` (cosmetics).
- Produces: `PresenceMeta.skin: string`; `PlayerInfo.skin: string`; `RealtimeClient.setSkin(id: string): void`; `RealtimeClient.connect(room, name, hue, skin?)`; `GhostView.skin?: string`; `drawGhost(ctx, cam, g, showNames)` unchanged in arity (reads `g.skin`).

- [ ] **Step 1: Write the failing test additions**

In `test/multiplayer.ts`, add a case (follow the file's existing multi-client harness — several `RealtimeClient`s over the in-memory relay). Assert that a peer's `skin` shows up in another client's roster, and that a peer who never set a skin surfaces as `'classic'` (the default from `blankMeta`). Sketch, adapted to the file's existing helpers for spinning up clients and reading rosters:

```typescript
// --- skin propagates through Presence ---------------------------------------
{
  const a = makeClient('ROOMX');   // use whatever factory the suite already defines
  const b = makeClient('ROOMX');
  await join(a); await join(b);
  a.setSkin('nova');
  await settle();                  // existing helper that flushes presence
  const roster = b.roomState().players;
  const peer = roster.find((p) => p.id === a.selfId)!;
  check('skin propagates', peer.skin === 'nova', `got ${peer.skin}`);
  const self = roster.find((p) => p.id === b.selfId)!;
  check('default skin is classic', self.skin === 'classic', `got ${self.skin}`);
}
```

If the suite exposes rosters differently (e.g. via an `onPlayers` callback rather than `roomState()`), use that exact accessor. The intent: after `setSkin('nova')` and a presence flush, another client sees `skin === 'nova'`; an unset client reads `'classic'`.

- [ ] **Step 2: Run to confirm it fails**

Run: `npm test`
Expected: FAIL — `PlayerInfo`/`PresenceMeta` have no `skin`, so the property is `undefined` and the assertions fail (or TS build fails on unknown property).

- [ ] **Step 3: Extend the protocol types**

In `src/net/protocol.ts`:
- Add `skin: string;` to `PlayerInfo` (after `hue`).
- Add to `PresenceMeta`, after `hue`, with a documenting comment:

```typescript
  /**
   * The player's equipped cosmetic skin id. A static, low-frequency field — set on join
   * and on re-equip only, never in the `pos` hot path or `RoomMeta`. Absent ⇒ 'classic'.
   */
  skin: string;
```

- [ ] **Step 4: Default it and map it in realtime.ts**

- In `blankMeta()` (realtime.ts:475), add `skin: 'classic'`:

```typescript
function blankMeta(): PresenceMeta {
  return { id: '', name: '', hue: 200, strokes: 0, total: 0, state: 'idle', done: false, doneHole: 0, joinedAt: 0, skin: 'classic' };
}
```

- Change `connect` (realtime.ts:92/107) to accept and store the skin:

```typescript
connect(room: string, name: string, hue: number, skin = 'classic'): void {
```
and in the meta construction at line 107 append `, skin`:
```typescript
this.meta = { ...blankMeta(), id: this.selfId, name: name.slice(0, 18) || 'Player', hue, skin, joinedAt: Date.now() };
```

- Replace the temporary `setSkin` stub (from Task 5) with the real one; place it beside the other meta-mutating methods (near `markDone`, ~line 421). It updates local meta and re-tracks so the change propagates immediately:

```typescript
setSkin(id: string): void {
  this.meta.skin = id;
  this.transport?.track({ ...this.meta });
}
```

- In `players()` (realtime.ts:255), add `skin` to the returned object:

```typescript
        hue: meta.hue,
        skin: meta.skin ?? 'classic',
```

The `?? 'classic'` is the absent-field fallback that keeps older/again clients safe.

- [ ] **Step 5: Thread skin into the ghost view + render**

- In `src/render/renderer.ts`, add `skin?: string;` to the `GhostView` interface. In `drawGhost`, when `g.skin` is present and not `'classic'`, tint the ring with the skin accent. Since `renderer.ts` should not import game modules circularly, pass the accent as part of the view: instead add `accent?: string;` to `GhostView` and set the ring stroke to `g.accent ?? \`hsla(${g.hue}, 100%, 82%, 0.95)\``. Replace the existing `ctx.strokeStyle = \`hsla(${g.hue}, 100%, 82%, 0.95)\`;` line in `drawGhost` with:

```typescript
  ctx.strokeStyle = g.accent ?? `hsla(${g.hue}, 100%, 82%, 0.95)`;
```

- In `src/game/game.ts`, where the `GhostView` is built (game.ts:643), import `skinById` from `../game/cosmetics` and set the accent:

```typescript
      const view: GhostView = {
        id: g.info.id,
        name: g.info.name,
        hue: g.info.hue,
        x: g.render.x,
        y: g.render.y,
        state: g.info.state,
        strokes: g.info.strokes,
        skin: g.info.skin,
        accent: skinById(g.info.skin ?? 'classic').accent,
      };
```

(`g.info` is a `PlayerInfo`, which now carries `skin`.)

- [ ] **Step 6: Pass the equipped skin on connect**

In `src/main.ts` at `game.net.connect(room, settings.playerName, settings.hue);` (main.ts:335), add the equipped skin:

```typescript
game.net.connect(room, settings.playerName, settings.hue, cosmetics.equipped);
```

The in-page simulated peer path (main.ts:904/912) may keep the 3-arg form (defaults to `'classic'`) or pass a skin for demo variety — either is fine.

- [ ] **Step 7: Run tests to confirm they pass**

Run: `npm test`
Expected: PASS — including the new multiplayer skin-propagation checks.

Run: `npm run build`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/net/protocol.ts src/net/realtime.ts src/game/game.ts src/render/renderer.ts src/main.ts test/multiplayer.ts
git commit -m "feat(cosmetics): broadcast equipped skin via Presence and tint ghosts"
```

---

### Task 8: Full regression pass + docs

**Files:**
- Modify: `README.md` (move relevant items out of "Not built yet"; document music, colorblind mode, cosmetics/Stardust)
- Modify: `CLAUDE.md` (note the new `cosmetics.ts` persistence module and the `skin` Presence field)

**Interfaces:** none.

- [ ] **Step 1: Headless + build + e2e**

Run: `npm test`
Expected: PASS (smoke, stats, multiplayer, cosmetics).

Run: `npm run build`
Expected: PASS.

Run: `npm run test:e2e`
Expected: PASS — the existing 59 checks still green (music/colorblind/cosmetics are additive; ghost rendering has a default fallback, so the multiplayer e2e path is unaffected).

- [ ] **Step 2: Confirm generation is untouched**

Run: `npm run audit`
Expected: report prints; cup-surface distributions and hazard frequencies match pre-update numbers (no `generator.ts`/`physics.ts` edits were made, so output must be identical).

- [ ] **Step 3: Update docs**

In `README.md`: under "Career stats and achievements" or a new short section, document Stardust (earned per hole by performance, spent in the cosmetics shop, device-local) and colorblind mode + music in the controls/settings notes. Remove "Music" from the "Not built yet" list.

In `CLAUDE.md`: in the persistence paragraph ("Persistence is three independent localStorage modules…"), change "three" to "four" and add `cosmetics.ts` (its key `orbit-golf.cosmetics.v1`). In the multiplayer section, add one line: the equipped skin id travels as a static `skin` field on `PresenceMeta`, defaulted to `'classic'`, read with a fallback — not part of `RoomMeta` or the `pos` broadcast.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document music, colorblind mode, and the cosmetics/Stardust system"
```

---

## Self-Review Notes

- **Spec coverage:** A (music) → Task 1; B (colorblind) → Task 2; C1 currency + C2 earning → Tasks 3–4; C3 shop → Task 5; C4 ball rendering → Task 6; C5 Presence broadcast → Task 7; testing (`test/cosmetics.ts`, multiplayer case, regression guard) → Tasks 3, 7, 8. All spec sections mapped.
- **Isolation guard:** No task edits `generator.ts`, `physics.ts`, or the advancement logic; Task 8 Step 2 verifies via `npm run audit`.
- **Type consistency:** `Skin`/`Cosmetics` shape and the function names (`awardFor`, `grant`, `buy`, `equip`, `skinById`, `loadCosmetics`, `saveCosmetics`, `resetCosmetics`) are defined once in Task 3 and reused verbatim in Tasks 4–7. `drawBall` gains a `skin` param (Task 6); `drawAim` gains a `colorblind` param (Task 2); `connect` gains an optional `skin` param and `setSkin` is stubbed in Task 5 then implemented in Task 7 — the stub/replace handoff is called out explicitly to keep each task independently buildable.
- **Fallbacks:** absent Presence `skin` → `'classic'` in `players()` and `blankMeta()`; `skinById` returns the default for unknown ids; default `classic` skin reproduces the original ball look so single-player visuals are unchanged until a skin is equipped.
