# Multiplayer Manual Advancement — Design

Date: 2026-07-25
Status: Approved for planning

## Problem

Multiplayer hole advancement is automatic and timing-based, and it desyncs. When every
player *appears* finished, the host starts a 4-second countdown and then bumps the room to
the next hole. Over Supabase's real, occasionally-inconsistent Presence, clients can
briefly disagree about who the host is or who has finished. A client that transiently
believes it is the host (because the true host momentarily dropped from its Presence view)
advances the room from *its* view and broadcasts the change, but the other clients reject
it — they accept room state only from *their* elected host. Result: one player rolls to the
next hole while everyone else is stranded on the previous one with no way forward.

A second, compounding issue: `finishHole` calls `net.markDone(...)`, which sets
`done`/`doneHole` and announces ready **the instant a player sinks or concedes**. So a
player is counted as "finished for advancement" before the "Ready" button on the result
card means anything — the room can begin advancing the moment the last ball drops.

## Goal

Replace automatic, timer-based advancement with a single **explicit host action**, gated on
the host actually observing that every player in the room is Ready. No timers, no
per-client advancement, no split-second races.

## Decisions (locked in brainstorming)

1. **Explicit Ready step.** Finishing a hole (holing out or conceding) records your score
   and shows the result card with a **Ready** button. You are *not* counted as done until
   you press Ready.
2. **Still-playing players keep playing.** The waiting panel appears only after *you* press
   Ready. Players still playing keep playing uninterrupted, with a small HUD indicator
   showing how many are ready (e.g. "2/4 ready").
3. Advancement is **host-only, manual, and gated**: the host's "Next hole" button is
   disabled until every player in the room is Ready. Non-hosts never see the button.

## Out of scope / unchanged

- Solo play: the result card's "Next hole" button advances immediately, as today.
- Scoring, penalties, restart rules, ghosts, kick, lobby start/return.
- Host election (earliest joiner, deterministic) and the "accept state only from the
  elected host" anti-spoofing rule — both retained; the fix rides on top of them.
- Course generation / determinism / physics — untouched.

## Behavior

### Per-player flow
1. Ball is holed or the hole is conceded → `finishHole` records the score and shows the
   **result card**. In multiplayer the card's primary button reads **Ready**; the subtitle
   reads "Press Ready when you're done." Finishing no longer marks you done.
2. Press **Ready** → you are marked done (`markReady`: sets `doneHole`, fast-broadcasts
   `ready`, updates Presence) → the result card is replaced by the **waiting panel**.
3. **Waiting panel** lists every player in two groups — **Ready** and **Still playing** —
   updating live as `ready`/Presence changes arrive. At the bottom:
   - **Host:** a **Next hole** button, disabled until every player is Ready.
   - **Non-host:** the text "Waiting for the host to start the next hole." No button.
4. Host presses **Next hole** → `advanceHole()` (host-only; re-checks everyone-ready) →
   commits `hole + 1` and broadcasts room state → every client applies it, loads the next
   hole together, and the waiting panel closes.

### Still-playing HUD
While connected, in the `playing` phase, and not yet Ready, a small HUD chip shows
`"<readyCount>/<total> ready"`, so a player mid-hole knows how many are waiting on them.
It disappears once that player presses Ready (they then see the waiting panel).

### Host handoff
If the host leaves while the room is waiting, the deterministic re-election makes the next
earliest joiner the host. Because the button's visibility/enablement is derived from
"am I host" + the roster's readiness, the new host's panel simply gains an appropriately
enabled Next button on the next state emit. No special-casing.

## Implementation shape

### `src/net/realtime.ts`
- **Remove the countdown machinery entirely:** `advanceDelayMs`/`setAdvanceDelay`,
  `advanceTimer`, `startCountdown`, `cancelCountdown`, `checkAdvance`, and the
  `onCountdown` handler call. Advancement is no longer time-driven.
- Rename for clarity: `isFinished` → `isReady`, `everyoneFinished` → `everyoneReady`
  (same logic: a player is ready iff `readyIds.has(id) || meta.doneHole === current hole`).
- `noteReady(id)`: add to `readyIds`; if host, `emitState()` so the panel/button refresh
  (previously called `checkAdvance`).
- `onPresence` host branch: `broadcastState()` + `emitState()` (drop `checkAdvance`).
- New host action:
  ```ts
  advanceHole(): void {
    if (!this.amHost || this.roomMeta.phase !== 'playing') return;
    if (!this.everyoneReady()) return;
    this.commitRoomMeta({ ...this.roomMeta, hole: this.roomMeta.hole + 1 });
  }
  ```
- `RealtimeHandlers.onCountdown` is removed from the interface.

### `src/net/protocol.ts`
- Remove `CountdownPayload` and `'countdown'` from `BroadcastEvent`. `PresenceMeta`,
  `PlayerInfo` (which already carries `done`), `RoomMeta`, `StatePayload`, `ReadyPayload`,
  `PosPayload` are otherwise unchanged.

### `src/game/game.ts`
- `finishHole` (multiplayer branch): record the score **without** marking ready. Replace
  `net.markDone(strokes, result)` with a score-only update (new `net.markScore(strokes,
  result)` that sets `strokes`/`state` and tracks Presence but does **not** set
  `done`/`doneHole` or announce ready). Keep `waitingForOthers = false` here (the player is
  on the result card, not yet waiting).
- `nextHole` (multiplayer branch) stays `markReady()` + `waitingForOthers = true`, but the
  screen switch to the waiting panel is driven by main.ts (see below).
- Remove the `countdown` field and the "Next hole in N…" branch of `drawStatus`. The
  "Waiting for other players…" canvas text is replaced by the DOM waiting panel + HUD chip,
  so `drawStatus` no longer needs the waiting branch.
- `applyRoomState`: when the hole changes while already `playing` (`holeChanged &&
  !enteredPlay`), call a new callback `onAdvance()` so main.ts can close the waiting panel
  and return to the game screen. Existing `enteredPlay`/`onPhaseChange` path is unchanged.
- `hud()` gains `ready: number` and keeps `waiting`, so the HUD chip can render
  `"<ready>/<players.length> ready"`.

### `src/main.ts` + `index.html` + `src/styles.css`
- **Result card:** in multiplayer, button label "Ready", subtitle "Press Ready when you're
  done." On click: mark ready via `game.nextHole()` (which calls `markReady`) and open the
  new waiting panel instead of the game screen. Solo unchanged (advances + game screen).
- **Waiting panel** (`#wait`, following the existing `.overlay`/`.panel.sheet` convention
  used by `#stats`/`#shop`): a "Ready" list and a "Still playing" list rendered from the
  roster; a footer that shows, for the host, `#btn-advance` "Next hole" (disabled until all
  ready), and for non-hosts, the waiting text. Re-rendered from `game.onPlayersChanged`
  and `game.onRoomState` while the panel is open.
- **HUD chip:** a small element updated in `onPlayersChanged` showing `"<ready>/<total>
  ready"` while playing, connected, and the local player is not yet ready.
- Wire `game.onAdvance` to close `#wait`/`#result` and `openScreen('game')`.
- Remove the `onCountdown` wiring (game constructor handler and the simulated-peer stub in
  `main.ts`).

### Tests & tooling
- `test/multiplayer.ts`: replace the countdown/`setAdvanceDelay`-based advancement cases
  with `advanceHole()` cases:
  - advance is a **no-op while any player is not ready** (hole unchanged);
  - once **all** players are ready, host `advanceHole()` bumps the hole for all clients;
  - a **non-host** calling `advanceHole()` does nothing;
  - after the host leaves, the **re-elected host** can advance once everyone is ready.
- `scripts/browser-smoke.js`: update the multiplayer e2e path — drive the flow via the new
  Ready → host "Next hole" button instead of waiting on a countdown; remove any
  `setAdvanceDelay` usage.

## Risks

The change is confined to `net/` (advancement authority), the `game.ts` net glue, and the
multiplayer UI. It does **not** touch generation, physics, host election, or the
"accept state only from the elected host" boundary. The multiplayer test suite is the
regression guard and is rewritten to cover the new gated action directly. The main
behavioral risk — a player never becoming "ready" and stalling the room — is inherent to a
manual gate and is the intended design: the host waits, sees who is outstanding in the
panel, and can `kick` a truly-stuck player (existing action), after which `everyoneReady`
no longer counts them.
