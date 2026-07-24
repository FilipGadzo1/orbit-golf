# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Vite client on :5173 + room server on :8787 (proxied /ws)
npm run build      # tsc --noEmit && vite build — always run before test:e2e
npm test           # headless suites (no browser)
npm run test:e2e   # Chromium, two players, writes screenshots/ — needs a fresh build
npm run audit      # samples 16k generated holes + 23k simulated shots, prints a report
npm start          # serves dist/ + WebSocket on one port (PORT env, default 8787)
```

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
level. Multiplayer relies on it: the server never sends level geometry, only a seed and a
hole number, and every client regenerates the same solar system locally.

Consequences:
- Never use `Math.random()` inside generation. Use `Rng` (mulberry32) seeded from
  `seed ^ imul(index, ...)`.
- `updateBodies(level, t)` positions orbiting bodies from **absolute** time `t`, not by
  integrating deltas. It is safe to call repeatedly, out of order, or to rewind.
  `predictTrajectory` depends on this: it snapshots body positions, runs the sim forward,
  and restores them.
- `test/smoke.ts` asserts determinism directly; the stats suite does not cover it.

## Server authority boundary

`server/index.js` is authoritative over room-level state: **seed**, **hole number**,
**phase** (`lobby`/`playing`), **host**, and **room config** (aim policy, allow-restart).
It is not authoritative over physics — ball positions broadcast at ~20 Hz are cosmetic
ghosts only, each client simulates its own ball. Rooms are in-memory and vanish when
empty; there is no database anywhere in this project.

Host-only actions (`start`, `kick`, `config`, `lobby`) are enforced server-side — the
server checks `room.host === player.id` and silently drops the message otherwise, so
hiding a button in the client is a UX nicety, not the security boundary. The oldest
remaining player inherits the host role via `ensureHost` when the host disconnects.

The client mirror is `Game.applyRoomState`, the **single** entry point for every `state`
message. It diffs phase and hole against the previous values to decide when to switch
screens (`onPhaseChange`) and reload the course. A `welcome` is baselined from `lobby` so
joining a game already in progress still registers as a transition. If you add room state,
extend `RoomState` in `protocol.ts` and thread it through `applyRoomState` — don't add
side-channel messages.

The room advances when every player is `done` (holed out, or pressed Ready), after a 4s
countdown. Scores are kept honest client-side: restarting a hole in multiplayer carries
strokes over and adds a penalty, and the result card's replay button is hidden once a
hole is scored.

The WebSocket URL is resolved in `net/client.ts`: build-time `VITE_WS_URL` (static-client
+ separate-server deploys) → `localStorage['orbit-golf.serverUrl']` runtime override →
same-origin `/ws` (the single-service default that `render.yaml` and `npm start` rely on).

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

Persistence is three independent localStorage modules, each with its own key and
`load`/`save` pair: `settings.ts`, `stats.ts` (migrates the legacy `progress.v1` record),
`friends.ts`. Nothing else touches localStorage.

## Test hooks in production code

`main.ts` assigns `window.__game`, and `Game` exposes `__aiming`, `__sim` and
`__surfacePoint`. These exist solely for `scripts/browser-smoke.js` and are marked as
such. `game.airborneTimeout` is a field rather than a constant so the e2e test can shorten
it instead of waiting 60 seconds.

## When changing generation or difficulty

Run `npm run audit`. It reports cup-surface distribution per tier, hazard frequency, world
sizes and simulated shot distances. It is how the achievement list was confirmed reachable
— several achievements depend on generated content actually occurring (a lava or gas cup,
a black hole spawning at all), and those relationships are not obvious from reading
`specFor` alone. The cup is deliberately never placed on a black hole or repulsor.
