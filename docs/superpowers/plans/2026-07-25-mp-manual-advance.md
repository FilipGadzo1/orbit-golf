# Multiplayer Manual Advancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fragile timer-based auto-advance with an explicit, host-gated "Next hole" action plus a Ready step and a live waiting panel, fixing the desync where one player jumps ahead while others are stranded.

**Architecture:** Advancement authority stays host-only but becomes manual: the host calls `advanceHole()`, which is a no-op unless every player in the room is Ready. The automatic countdown/timer is removed entirely. Finishing a hole now records score only; pressing Ready is what marks a player done. The waiting panel and HUD "ready" counter render from the existing roster (`PlayerInfo.done`).

**Tech Stack:** TypeScript (strict), Vite, Canvas 2D, Supabase Realtime (Presence + Broadcast), esbuild-bundled headless Node tests, Playwright e2e.

## Global Constraints

- Advancement is **host-only and manual**: `advanceHole()` returns without effect unless `amHost`, `phase === 'playing'`, and `everyoneReady()`. No timers, no per-client advancement.
- Every client advances via the host's single `state` broadcast; clients still **accept `state` only from `electHost()`** (anti-spoofing rule — unchanged).
- **Do NOT change** host election (`electHost`), the seed/course generation, `physics.ts`, or the "accept state only from host" boundary.
- **Finishing ≠ done.** `finishHole` records score without marking ready; `markReady` (Ready button) sets `done`/`doneHole` and fast-broadcasts `ready`.
- TypeScript strict (`noUnusedLocals`/`noUnusedParameters`): removing `onCountdown` from `RealtimeHandlers` means every handler object (game.ts, test, main.ts sim-peer) must drop it, or the build fails.
- Each task must leave `npm test` and `npm run build` green.
- The `test/multiplayer.ts` suite is the regression guard for host election, kick, reassignment, and the stale-done no-skip invariant — those cases must stay covered after the rewrite.

---

### Task 1: Net + game-logic core + headless test rewrite

**Files:**
- Modify: `src/net/protocol.ts`
- Modify: `src/net/realtime.ts`
- Modify: `src/game/game.ts`
- Modify: `src/main.ts` (only the minimal edits to keep it compiling — remove the `onCountdown` handler on the in-page simulated peer)
- Test: `test/multiplayer.ts` (rewrite advancement cases)

**Interfaces:**
- Produces: `RealtimeClient.advanceHole(): void`; `RealtimeClient.markScore(n: number, result: 'sunk' | 'lost'): void`; `RealtimeHandlers` no longer has `onCountdown`; `Game.onAdvance: () => void`; `Game.hud()` returns `ready: number`.
- Consumes: existing `markReady()`, `everyoneReady()` (renamed from `everyoneFinished`), `isReady()` (renamed from `isFinished`), `PlayerInfo.done`.

- [ ] **Step 1: Rewrite the multiplayer test's advancement + supporting bits (failing test first)**

In `test/multiplayer.ts`:

Change the import (drop `setAdvanceDelay`):
```ts
import { RealtimeClient } from '../src/net/realtime';
```

Remove the countdown field from the `Peer` harness — delete `lastCountdown = 0;` and the `onCountdown` handler in the constructor (the `RealtimeHandlers` object). Delete the `setAdvanceDelay(40);` line in `main()`.

Replace the **hole advancement** section (the block from `// ---- hole advancement` through the "host finishes last" check) with manual, gated advancement:
```ts
  // ---- hole advancement (manual, host-gated) --------------------------------
  // Finishing records score only; pressing Ready marks a player done. The host advances
  // explicitly and only when everyone is ready — no timers, no per-client advance.
  a.client.markScore(3, 'sunk');
  b.client.markScore(4, 'sunk');
  a.client.markReady();
  b.client.markReady();
  for (let i = 0; i < 10; i++) {
    a.client.sendPos(1, 1, 'sunk', (t += 60));
    b.client.sendPos(2, 2, 'sunk', (t += 60));
  }
  await sleep(20);
  a.client.advanceHole(); // host, but Lin is not ready yet
  await sleep(20);
  check('host cannot advance until everyone is ready', a.hole === 1, `hole=${a.hole}`);

  b.client.advanceHole(); // non-host, everyone-not-ready anyway
  await sleep(20);
  check('a non-host cannot advance the room', a.hole === 1, `hole=${a.hole}`);

  c.client.markReady();
  await sleep(20);
  a.client.advanceHole(); // host, everyone ready
  await sleep(20);
  check('host advances once every player is ready', a.hole === 2 && b.hole === 2 && c.hole === 2, `${a.hole}/${b.hole}/${c.hole}`);
  check('scores carry into the running total after a hole', (a.players.find((p) => p.name === 'Ada')?.total ?? -1) === 3, `total=${a.players.find((p) => p.name === 'Ada')?.total}`);
  check('the done flags reset for the new hole', a.players.every((p) => !p.done), JSON.stringify(a.players.map((p) => p.done)));

  // Non-host readiness alone must not advance; only the host's explicit action does.
  b.client.markReady();
  c.client.markReady();
  await sleep(30);
  check('room stays put while the host has not advanced', a.hole === 2, `hole=${a.hole}`);
  a.client.markReady();
  a.client.advanceHole();
  await sleep(20);
  check('host advances the room on its explicit action', a.hole === 3 && b.hole === 3 && c.hole === 3, `${a.hole}/${b.hole}/${c.hole}`);
```

Replace the **stale-done no-skip** section (from `slow.client.markDone(3, 'sunk');` onward) so it drives the manual action, keeping the invariant that a stale `doneHole` from a previous hole never lets the current hole advance:
```ts
  // Both finish + ready hole 1 → host advances to hole 2 (Slow is blocked from 'state').
  slow.client.markScore(3, 'sunk');
  slow.client.markReady();
  host.client.markScore(3, 'sunk');
  host.client.markReady();
  await sleep(20);
  host.client.advanceHole();
  await sleep(20);
  check('host advances to hole 2', host.hole === 2, `host hole=${host.hole}`);
  check('the stuck player is still on hole 1', slow.hole === 1, `slow hole=${slow.hole}`);

  // Host readies hole 2. Slow's doneHole is still 1 (stale) → host cannot advance.
  host.client.markScore(2, 'sunk');
  host.client.markReady();
  host.client.advanceHole();
  await sleep(20);
  check('the room does NOT skip ahead while a player is behind', host.hole === 2, `host hole=${host.hole}`);

  // Recovery: unblock Slow; the host re-asserts state on the next Presence change.
  memoryTransports.get(slow.client.selfId)!.blockedEvents.delete('state');
  slow.client.markStrokes(1);
  await sleep(30);
  check('a lagging player catches up to the current hole', slow.hole === 2, `slow hole=${slow.hole}`);
  slow.client.markScore(4, 'sunk');
  slow.client.markReady();
  await sleep(20);
  host.client.advanceHole();
  await sleep(20);
  check('the room advances once the lagging player finishes and the host advances', host.hole === 3 && slow.hole === 3, `${host.hole}/${slow.hole}`);
```

Leave the earlier `markDone` in the reassignment/kick sections replaced too: the only remaining `markDone`/`markReady` semantics are `markScore` + `markReady`. Search the file for any remaining `markDone(` and convert each to `markScore(...); <peer>.client.markReady();` where the original intent was "finished this hole", or just `markScore` where readiness isn't needed. (After this rewrite there should be **no** `markDone` or `setAdvanceDelay` or `onCountdown`/`lastCountdown` references left in the file.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx esbuild test/multiplayer.ts --bundle --platform=node --format=esm --outfile=node_modules/.cache/mp.mjs && node node_modules/.cache/mp.mjs`
Expected: FAIL — `advanceHole`/`markScore` don't exist yet (esbuild resolve/type error or runtime `is not a function`).

- [ ] **Step 3: Update the protocol — remove countdown**

In `src/net/protocol.ts`:
- Delete the `CountdownPayload` interface.
- Change `export type BroadcastEvent = 'state' | 'pos' | 'kick' | 'countdown' | 'ready';` to `export type BroadcastEvent = 'state' | 'pos' | 'kick' | 'ready';`.

- [ ] **Step 4: Rework realtime.ts — remove countdown, add manual advance**

In `src/net/realtime.ts`:

Remove the countdown import: delete `type CountdownPayload,` from the protocol import block.

Delete the exported countdown knobs (lines ~36-40):
```ts
export let advanceDelayMs = 4000;
export function setAdvanceDelay(ms: number): void { advanceDelayMs = ms; }
```

In `RealtimeHandlers` (interface), delete the `onCountdown: (seconds: number) => void;` line.

Delete the `private advanceTimer` field.

In `onPresence`, replace the host branch body and drop the timer-cancel else-branch:
```ts
  private onPresence(p: PresenceMap): void {
    this.presence = p;
    if (this.electHost() === this.selfId) {
      // Re-assert room state on every roster/score change (cheap; makes the room
      // self-healing) and refresh the local view so the host's Next button reflects
      // current readiness.
      this.broadcastState();
      this.emitState();
    }
    this.emitState();
  }
```
(The final `this.emitState()` after the block is fine to keep; the host path calling it twice is harmless. If you prefer, drop the in-branch `emitState()` and keep only the trailing one — either is correct.)

In `onMessage`, delete the entire `case 'countdown':` block.

Rename `isFinished` → `isReady` and `everyoneFinished` → `everyoneReady` (update the doc comments to say "ready"). Update their call sites (`players()` uses `isReady`; the new `advanceHole` and `everyoneReady` internal use).

Replace `noteReady` and `checkAdvance`/`startCountdown`/`cancelCountdown` with a manual model:
```ts
  /** Records that a player readied for the current hole and refreshes the host's view. */
  private noteReady(id: string): void {
    this.readyIds.add(id);
    if (this.amHost) this.emitState();
  }
```
Delete `checkAdvance`, `startCountdown`, and `cancelCountdown` entirely.

Add the host action (place it near the other host actions, e.g. after `start()`):
```ts
  /** Host-only, manual, gated: advance to the next hole only when everyone is ready. */
  advanceHole(): void {
    if (!this.amHost || this.roomMeta.phase !== 'playing') return;
    if (!this.everyoneReady()) return;
    this.commitRoomMeta({ ...this.roomMeta, hole: this.roomMeta.hole + 1 });
  }
```

Split score-recording from readiness. Replace `markDone` with `markScore` (score only — no `done`/`doneHole`, no `announceReady`):
```ts
  /** Records the player's finished-hole score without marking them ready. */
  markScore(n: number, result: 'sunk' | 'lost'): void {
    this.meta.strokes = Math.max(0, Math.min(999, n | 0));
    this.meta.state = result === 'sunk' ? 'sunk' : 'lost';
    this.trackMeta();
  }
```
Keep `markReady` exactly as-is (it sets `done`/`doneHole`, tracks, and `announceReady()`).

In `disconnect()`, delete the `advanceTimer` clear block (the field no longer exists).

- [ ] **Step 5: Update game.ts glue**

In `src/game/game.ts`:
- In the `RealtimeClient` handlers object (constructor), delete the `onCountdown: (s) => { ... }` handler.
- Delete the `private countdown` field and remove the `if (this.countdown > now) { ... }` branch from `drawStatus` (keep the rest of `drawStatus`; the `waitingForOthers` branch there can be removed too since the DOM waiting panel replaces it — leave the `statusUntil`/`statusMessage` branch).
- In `finishHole`, change the multiplayer branch:
  ```ts
  if (this.net.connected) {
    this.net.markScore(this.strokes, outcome === 'sunk' ? 'sunk' : 'lost');
  }
  ```
  (Remove the `this.waitingForOthers = true;` here — the player is on the result card, not yet waiting. `nextHole()` sets `waitingForOthers` when they press Ready.)
- Add the advance callback field near the other `on*` callbacks:
  ```ts
  /** Fired when the room rolls to a new hole while already playing, so the UI can leave the waiting panel. */
  onAdvance: () => void = () => {};
  ```
- In `applyRoomState`, inside the `if (enteredPlay || holeChanged)` block, after `this.loadHole(state.hole);`, add: `if (holeChanged && !enteredPlay) this.onAdvance();` (call it alongside the existing `sfx.levelUp()`).
- In `hud()`, add `ready: this.players.filter((p) => p.done).length,` to the returned object. Update the `HudState` type (wherever it's declared) to include `ready: number`.

- [ ] **Step 6: Keep main.ts compiling (minimal)**

In `src/main.ts`, find the in-page simulated-peer `RealtimeClient` handlers (around the `onState`/`onCountdown: () => {}` block) and delete its `onCountdown: () => {},` line so the handler object matches the trimmed `RealtimeHandlers`. Do not build the waiting panel yet (Task 2). Leave the existing result-card `btn-next` handler as-is for now — it already calls `game.nextHole()`, which still calls `markReady()`.

- [ ] **Step 7: Run the full suite + build to verify green**

Run: `npm test`
Expected: PASS — all 4 suites, including the rewritten multiplayer advancement + stale-done cases.

Run: `npm run build`
Expected: PASS (no references to removed `onCountdown`/`CountdownPayload`/`setAdvanceDelay`/`markDone`/`countdown`).

- [ ] **Step 8: Commit**

```bash
git add src/net/protocol.ts src/net/realtime.ts src/game/game.ts src/main.ts test/multiplayer.ts
git commit -m "feat(mp): host-gated manual hole advancement, remove countdown"
```

---

### Task 2: Multiplayer waiting-panel UI + Ready flow + HUD counter

**Files:**
- Modify: `index.html` (waiting panel `#wait`; result-card copy)
- Modify: `src/main.ts` (Ready→panel, panel render, advance button, `onAdvance`, HUD chip)
- Modify: `src/styles.css` (panel + HUD chip styling)

**Interfaces:**
- Consumes: `Game.onAdvance`, `Game.net.advanceHole()`, `Game.nextHole()` (calls `markReady`), `Game.isHost`, the roster from `game.onPlayersChanged`/`game.onRoomState` (`PlayerInfo` with `done`, `name`, `hue`, `id`), existing helpers `$`, `show`, `openScreen`, `sfx.ui()`.
- Produces: `renderWait()` in main.ts.

- [ ] **Step 1: Add the waiting panel markup**

In `index.html`, add an overlay following the existing `#shop`/`#stats` pattern (`.overlay.hidden` → `.panel.sheet.sheet-narrow` → `.sheet-head` / `.sheet-body` / `.sheet-foot`):
```html
<div id="wait" class="overlay hidden">
  <div class="panel sheet sheet-narrow">
    <header class="sheet-head"><h2>Hole complete</h2></header>
    <div class="sheet-body">
      <section>
        <h3 class="wait-group-title">Ready</h3>
        <ul id="wait-ready" class="wait-list"></ul>
        <h3 class="wait-group-title">Still playing</h3>
        <ul id="wait-playing" class="wait-list"></ul>
      </section>
    </div>
    <footer class="sheet-foot">
      <span id="wait-msg" class="wait-msg"></span>
      <button id="btn-advance" class="btn btn-primary" disabled>Next hole</button>
    </footer>
  </div>
</div>
```

- [ ] **Step 2: Result card → mark ready → open the waiting panel**

In `src/main.ts`, update the result-card subtitle for multiplayer and change the `btn-next` click so multiplayer opens the waiting panel instead of the game screen:

In the `game.onHoleComplete` handler where `result-next` text is set, change the multiplayer string to `'Press Ready when you're done.'` and keep the solo `Up next…` string. Leave the `btn-next` label logic (`'Ready'` vs `'Next hole'`).

Replace the `btn-next` click handler:
```ts
$('btn-next').addEventListener('click', () => {
  sfx.ui();
  pendingResult = null;
  const mp = game.net.connected;
  game.nextHole(); // MP: markReady + waitingForOthers; solo: advance
  if (mp) {
    renderWait();
    openScreen('wait');
  } else {
    openScreen('game');
  }
});
```

- [ ] **Step 3: Render the waiting panel**

In `src/main.ts`, add `wait`, `waitReady`, `waitPlaying`, `waitMsg`, and `btnAdvance` to the `els` lookup, then:
```ts
function renderWait(): void {
  const players = game.players; // current roster (PlayerInfo[])
  const ready = players.filter((p) => p.done);
  const playing = players.filter((p) => !p.done);
  const fill = (ul: HTMLElement, list: typeof players) => {
    ul.innerHTML = '';
    for (const p of list) {
      const li = document.createElement('li');
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.style.background = `hsl(${p.hue}, 95%, 68%)`;
      const name = document.createElement('span');
      name.className = `name${p.id === game.net.selfId ? ' you' : ''}`;
      name.textContent = p.name;
      li.append(chip, name);
      ul.append(li);
    }
  };
  fill(els.waitReady, ready);
  fill(els.waitPlaying, playing);
  const allReady = players.length > 0 && playing.length === 0;
  const host = game.isHost;
  show(els.btnAdvance, host);
  (els.btnAdvance as HTMLButtonElement).disabled = !allReady;
  els.waitMsg.textContent = host
    ? (allReady ? 'Everyone is ready.' : 'Waiting for all players to be ready…')
    : 'Waiting for the host to start the next hole.';
}

$('btn-advance').addEventListener('click', () => {
  sfx.ui();
  game.advanceRoomHole();
});
```
Expose the host action on `Game`: add `advanceRoomHole(): void { this.net.advanceHole(); }` (near the other host-action wrappers like `startMultiplayerGame`). Confirm `game.players` and `game.isHost` are accessible (public field / getter — `isHost` getter already exists; if `players` is private, add a public getter `get roster(): PlayerInfo[] { return this.players; }` and use it in `renderWait`).

- [ ] **Step 4: Keep the panel live + leave it on advance**

In `src/main.ts`:
- In `game.onPlayersChanged`, after the existing scoreboard update, add: `if (!els.wait.classList.contains('hidden')) renderWait();` so the lists/button update as readiness arrives.
- Wire the advance callback: `game.onAdvance = () => { pendingResult = null; openScreen('game'); };` (closes the `#wait` overlay by switching screens).
- Also handle the host who is still playing: they never open `#wait` (they're on the game screen) until they finish and press Ready; that's the intended flow, no extra code.

- [ ] **Step 5: HUD "X/Y ready" chip**

In `index.html`, add a small element in the in-game HUD area (near the existing status/room display): `<div id="hud-ready" class="hud-ready hidden"></div>`.

In `src/main.ts`, add `hudReady` to `els`, and in `game.onPlayersChanged` update it:
```ts
const h = game.hud();
const showReady = game.net.connected && h.phase === 'playing' && !h.waiting && players.length > 1;
show(els.hudReady, showReady);
if (showReady) els.hudReady.textContent = `${h.ready}/${players.length} ready`;
```
(`h.waiting` is true once the local player pressed Ready — they then see `#wait`, so the chip hides for them.)

- [ ] **Step 6: Style the panel + chip**

In `src/styles.css`, add `.wait-list` (flex column, gap), `.wait-list li` (row with chip+name, reuse `.chip`/`.name` conventions from the scoreboard), `.wait-group-title` (small caps subhead), `.wait-msg` (muted), and `.hud-ready` (small pill in the HUD), matching the existing panel/scoreboard visual language.

- [ ] **Step 7: Build + verify**

Run: `npm run build`
Expected: PASS.

Manual (`npm run dev`, two tabs via the in-page peer or two browsers with `?room=TEST`): finishing shows the result card with "Ready"; pressing Ready shows the waiting panel; the host's "Next hole" is disabled until all are ready; non-host sees the waiting text and no button; the still-playing tab shows "1/2 ready"; host clicking Next moves both tabs to the next hole and closes the panel.

- [ ] **Step 8: Commit**

```bash
git add index.html src/main.ts src/styles.css
git commit -m "feat(mp): waiting panel with host Next-hole gate and ready counter"
```

---

### Task 3: e2e update, docs, and full regression

**Files:**
- Modify: `scripts/browser-smoke.js`
- Modify: `README.md`, `CLAUDE.md`

**Interfaces:** none.

- [ ] **Step 1: Update the browser e2e multiplayer path**

In `scripts/browser-smoke.js`, find the multiplayer section that currently relies on the countdown/`setAdvanceDelay` to advance. Rewrite it to drive the new flow: after both the real client and the in-page peer finish a hole, click **Ready** (`#btn-next`) on the driven client, drive the peer to ready, then click the host **Next hole** button (`#btn-advance`) and assert both advanced to the next hole and the `#wait` overlay closed. Remove any `setAdvanceDelay`/countdown references. If the peer helper exposes `markDone`, update it to `markScore` + `markReady` to match the new net API (check `window.__orbitPeer` wiring in `main.ts`).

- [ ] **Step 2: Run the full regression (capture real output; do not fake)**

Run: `npm test` — expect all 4 suites green.
Run: `npm run build` — expect PASS.
Run: `npm run test:e2e` — expect PASS (drives the new Ready → host-advance flow). If Chromium can't run in the environment, report exactly what happened rather than faking.
Run: `npm run audit` — expect output consistent with pre-change generation (no generator/physics edits were made).

- [ ] **Step 3: Docs**

`README.md` — in the Multiplayer section, replace the sentence describing automatic advancement ("Once playing, the room advances to the next hole when every player has holed out or pressed Ready.") with the new flow: each player presses **Ready** after finishing; a waiting panel lists who is Ready vs still playing; the **host** advances everyone with a **Next hole** button that unlocks only once all players are Ready; a still-playing player sees an "X/Y ready" indicator. Note the host can `kick` a truly-stuck player to unblock the room.

`CLAUDE.md` — in the "Multiplayer: serverless, host-authoritative" section, replace the three-rule "Hole advancement is the subtle part" paragraph's description of the **countdown/settling-window** mechanism with the manual model: advancement is a host-only `advanceHole()` gated on `everyoneReady()`; there is no countdown timer; `readyIds` + `doneHole === currentHole` still define readiness and the stale-done guard (a `doneHole` from a previous hole never counts for the current one); clients still accept `state` only from the elected host. Keep the position-broadcast rate-budget note (still relevant).

- [ ] **Step 4: Commit**

```bash
git add scripts/browser-smoke.js README.md CLAUDE.md
git commit -m "docs+e2e: manual multiplayer advancement flow"
```

---

## Self-Review Notes

- **Spec coverage:** remove countdown → Task 1 (protocol + realtime); manual host gate `advanceHole` → Task 1; finishing≠done via `markScore`/`markReady` → Task 1 (+ game.ts); waiting panel + Ready flow + HUD counter → Task 2; `onAdvance` screen switch → Task 1 (game.ts) + Task 2 (main.ts wiring); test rewrite → Task 1; e2e + docs + regression → Task 3.
- **Buildability between tasks:** Task 1 removes `onCountdown` from `RealtimeHandlers` and updates all three handler objects (game.ts, test, main.ts sim-peer) in the same task, and replaces `markDone` with `markScore` at its only production call site (game.ts finishHole) — so the build is green at the end of Task 1 even though the waiting-panel UI arrives in Task 2.
- **Type consistency:** `advanceHole`, `markScore`, `everyoneReady`, `isReady`, `onAdvance`, `hud().ready`, `advanceRoomHole` are defined in Task 1/2 and consumed consistently. `PlayerInfo.done` (existing) drives both the panel groups and the HUD counter.
- **Invariant guard:** the stale-done no-skip case is preserved in the rewritten test (a previous-hole `doneHole` never satisfies `everyoneReady()` for the current hole), and host election / kick / reassignment cases are untouched.
- **Placeholder scan:** no TBDs; every code step has concrete code or an exact edit with the real identifiers from the current source.
