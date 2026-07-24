# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Vite dev server on :5173 (static app; no game server exists)
npm run build      # tsc --noEmit && vite build — always run before test:e2e
npm test           # headless suites: course, stats, multiplayer (no browser)
npm run test:e2e   # Chromium against the built app, writes screenshots/ — needs a fresh build
npm run audit      # samples 16k generated holes + 23k simulated shots, prints a report
```

The app is a **static client**; there is no server. Multiplayer runs on Supabase Realtime,
configured via `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY` (see
`.env.example`). Deploy is any static host (the user is on Vercel).

There is no test framework. `scripts/run-tests.js` bundles each `test/<name>.ts` with
esbuild into `node_modules/.cache/` and runs it in Node. To run one suite, edit the
`suites` array in that file, or bundle and run it directly:

```bash
npx esbuild test/stats.ts --bundle --platform=node --format=esm --outfile=tmp.mjs && node tmp.mjs
```

Adding a suite = drop `test/<name>.ts` in and add its name to `suites`.

`tsconfig.json` sets `noUnusedLocals` and `noUnusedParameters`, so a leftover import or
parameter fails the build, not just a lint step.

## The determinism contract

This is the invariant everything else hangs off. `generateLevel(seed, holeIndex)` in
`src/game/generator.ts` must be **pure and deterministic** — same inputs, byte-identical
level. Multiplayer relies on it: no level geometry is ever transmitted. The seed comes
from the room code and the hole number from the host, and every client regenerates the
same solar system locally.

Consequences:
- Never use `Math.random()` inside generation. Use `Rng` (mulberry32) seeded from
  `seed ^ imul(index, ...)`.
- `updateBodies(level, t)` positions orbiting bodies from **absolute** time `t`, not by
  integrating deltas. It is safe to call repeatedly, out of order, or to rewind.
  `predictTrajectory` depends on this: it snapshots body positions, runs the sim forward,
  and restores them.
- `test/smoke.ts` asserts determinism directly; the stats suite does not cover it.

## Multiplayer: serverless, host-authoritative

There is no server. Multiplayer runs on Supabase Realtime, and the logic that would
normally live server-side lives in `net/realtime.ts` (`RealtimeClient`). The layering:

- `net/transport.ts` — a `Transport` interface with two implementations: `SupabaseTransport`
  (production) and an in-memory relay (`memoryTransportFactory`) that lets several clients
  run against each other in one process. `RealtimeClient` picks the memory factory when
  `globalThis.__ORBIT_MEMORY_NET` is set (tests + the browser smoke test).
- **Presence** carries the player roster + per-player score (low frequency). **Broadcast**
  carries live positions (`pos`) and the host-authored room state (`state`).
- **Seed is derived from the room code** (`hashString(code)`) — no coordination, no
  "first joiner assigns it". Different code ⇒ different course.
- **Host election is deterministic**: earliest `joinedAt` in Presence, tie-broken by id.
  Every client computes the same host (`electHost`). The host owns `RoomMeta`
  (phase/hole/config), broadcasts it, and runs hole advancement. Non-hosts accept a `state`
  broadcast **only if `payload.by === electHost()`** — that's the anti-spoofing boundary,
  in place of a server check. Since there's no trusted server, this is best-effort integrity
  for a friends game, not hard security.

Client-side room state still flows through the **single** `Game.applyRoomState` entry
point, which diffs phase/hole to drive `onPhaseChange` (screen switch) and course reload.
`RealtimeClient` produces those `RoomState` snapshots from Presence + `RoomMeta`. If you
add room state, extend `RoomState`/`RoomMeta` in `protocol.ts` and thread it through both
`RealtimeClient` and `applyRoomState` — don't add side-channel broadcast events.

Per-hole score reset happens in `applyRoomMeta`: entering a new phase zeroes the card,
a hole change banks strokes into total and resets. The advance countdown delay is
`advanceDelayMs` (default 4000), overridable via `setAdvanceDelay` so tests don't wait.
Scores stay honest as before: multiplayer restart carries strokes + a penalty, and the
replay button is hidden once a hole is scored.

**Hole advancement is the subtle part** — three rules keep it correct under Supabase's
async, occasionally-inconsistent Presence:
1. *Finished-for-which-hole.* A player is "finished" only if their `ready` broadcast or
   their Presence `doneHole` matches the **current** hole. Trusting a bare `done` flag let
   the room skip ahead: a client that hadn't yet processed an advance still showed
   `done=true` from the previous hole. Never reintroduce a hole-agnostic done check.
2. *Countdown as a settling window.* When everyone appears finished the host starts the
   countdown; if an unfinished player (re)appears before it fires — e.g. a Presence resync
   that briefly dropped then restored them — it's cancelled, and advancement is re-verified
   at fire time. This absorbs transient roster/host blips.
3. *Self-healing state.* The host re-broadcasts room state on every Presence change, and
   election/roster reads go through `mergedPresence()` (own live meta overlaid), so a
   client that missed a `state` broadcast or is transiently absent from its own Presence
   converges rather than desyncing.

Position broadcasts only stream while the ball is flying (one final send at rest),
otherwise finished players would saturate the channel's rate budget and starve the
Presence/`ready` signals. `test/multiplayer.ts` covers all of this, including a
`blockedEvents` seam on the in-memory transport that simulates a client missing the
advance broadcast — reverting rule 1 makes that test fail with a hole-skip.

The equipped cosmetic skin id travels as a static `skin` field on `PresenceMeta` (set on
join and on re-equip only), defaulted to `'classic'` and read with a `?? 'classic'`
fallback — it is not part of `RoomMeta` or the `pos` broadcast.

## Physics scale

`G = 560` and `mass = density × radius²` are chosen together so that surface gravity works
out to exactly `G × density` — **independent of planet radius**. Large planets feel the
same underfoot but have a much deeper well to escape, which is what makes size read as
difficulty. Changing either constant rebalances the entire game.

The smoke suite guards the consequences rather than the numbers: weak taps must come to
rest (not escape to space), and holes must stay ace-able by brute force. An earlier
version had gravity ~30× too weak and every shot escaped; that is what those checks exist
to catch. Re-run `npm test` after touching `G`, mass, `MAX_SHOT_SPEED`, or the surface
table.

Contact handling in `physics.ts` distinguishes two regimes: an impact above
`BOUNCE_THRESHOLD` loses tangential speed as a single impulse, while resting contact is
damped over time (`exp(-friction·k·dt)`). Without that split, per-substep contacts kill
all rolling within milliseconds.

`SimState.contactAge` is seconds since the ball last touched anything. **`physics.ts` has
no shot timeout** — the 60s "adrift" rule lives in `Game.update` via
`game.airborneTimeout`, deliberately, so a long in-bounds flight is never cut short for
merely taking a while.

## Aim guide shares the real simulation

`predictTrajectory` calls the same `stepBall` as the live game. The dotted preview is a
genuine forward simulation, not an approximation, and its colour encodes the predicted
outcome. Do not fork a separate approximation for the preview — any physics change must
flow through both automatically.

## Module boundaries

`Game` (`src/game/game.ts`) owns the loop, input, camera policy and state. It is
UI-agnostic and talks to the DOM only through callback fields: `onHoleComplete`,
`onPlayersChanged`, `onNetStatus`, `onAchievements`. All DOM wiring lives in
`src/main.ts` against markup in `index.html` — there is no framework and no component
system, just `getElementById` and listeners.

Rendering is immediate-mode Canvas 2D with no scene graph. `src/render/*` exports plain
draw functions taking `(ctx, camera, …)`; `Camera.worldToScreen` is the only transform.

Persistence is four independent localStorage modules, each with its own key and
`load`/`save` pair: `settings.ts`, `stats.ts` (migrates the legacy `progress.v1` record),
`friends.ts`, `cosmetics.ts` (key `orbit-golf.cosmetics.v1`, Stardust balance + owned/
equipped ball skins). Nothing else touches localStorage.

## Test hooks in production code

`main.ts` assigns `window.__game`, and `Game` exposes `__aiming`, `__sim` and
`__surfacePoint`. These exist solely for `scripts/browser-smoke.js` and are marked as
such. `game.airborneTimeout` is a field rather than a constant so the e2e test can shorten
it instead of waiting 60 seconds.

For multiplayer, two Playwright tabs can't share the in-memory relay (separate JS
contexts), so the browser test sets `window.__ORBIT_MEMORY_NET = true` via `addInitScript`
(forcing the memory transport) and drives a real client plus a **simulated in-page peer**
exposed as `window.__orbitPeer` (guarded behind the same flag in `main.ts`). The deeper
multi-client logic — election, advancement, reassignment — is covered in `test/multiplayer.ts`
headlessly, where several `RealtimeClient`s share the process-local relay.

## When changing generation or difficulty

Run `npm run audit`. It reports cup-surface distribution per tier, hazard frequency, world
sizes and simulated shot distances. It is how the achievement list was confirmed reachable
— several achievements depend on generated content actually occurring (a lava or gas cup,
a black hole spawning at all), and those relationships are not obvious from reading
`specFor` alone. The cup is deliberately never placed on a black hole or repulsor.
