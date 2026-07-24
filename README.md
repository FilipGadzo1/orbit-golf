# Orbit Golf

2D minigolf across procedurally generated solar systems. Slingshot your ball between
planets, use gravity wells to curve around obstacles, and drop it in the cup on a
distant world — with friends watching your ball as a live ghost.

![title](screenshots/1-title.png)

## Running it

```bash
npm install
npm run dev          # client on :5173, multiplayer server on :8787
```

Open <http://localhost:5173>. The Vite dev server proxies `/ws` to the game server, so
multiplayer works in dev with no extra setup.

For friends on your network (or a deployed box), build once and serve everything from
the Node server on a single port:

```bash
npm run build
npm start            # http://localhost:8787 — set PORT to change it
```

Share that address plus a room code. Anyone can also deep-link straight into a lobby
with `?room=NEBULA`.

## How to play

| Action | Control |
| --- | --- |
| Putt | Drag **from the ball** away from where you want to go, release (slingshot) |
| Zoom | Mouse wheel, `+` / `-`, or the HUD buttons |
| Pan | Right-drag (or shift-drag) |
| Fit whole course | `F` |
| Recenter on ball | `C` |
| Replay hole | `R` |
| Concede hole | `X` |
| Multiplayer | `M` |
| Career stats | `T` |
| Settings | `Esc` |

Touch works too: one finger to aim and putt, two fingers to pinch-zoom and pan.

The dotted line is a real forward simulation of your shot — not an approximation — so
it accounts for every gravity well and bounce. Its colour tells you the predicted
outcome: **green** sinks it, **blue** is still flying, **orange** leaves the map,
**red** hits a black hole. Shorten or disable it in Settings if it makes things too easy.

## Course generation

Every course comes from a 32-bit seed; the same seed always produces the same holes,
which is how multiplayer keeps everyone on an identical course. Difficulty ramps with
the hole number:

| Holes | Tier | What shows up |
| --- | --- | --- |
| 1–5 | Easy | 2–3 planets, tight spacing |
| 6–12 | Medium | 3–5 planets, first orbiting bodies |
| 13–22 | Hard | 5–7 planets, black holes, repulsors |
| 23+ | Extreme | 7–10 bodies, multiple movers and hazards |

Surfaces behave differently: **ice** is slippery and bouncy, **lava** is grabby, **gas
giants** swallow momentum, **repulsors** push you away, and **black holes** eat your
ball for a penalty stroke. Leave the dashed boundary circle and you're lost in space —
also a penalty stroke, replayed from where you last came to rest.

A shot takes as long as it takes. Slow transfers and multi-orbit approaches are the
point of the game, so nothing is cut short for being lengthy. The only time limit is
that a ball which has touched *nothing at all* for 60 seconds is declared adrift and
costs a stroke — any bounce off any surface resets that timer.

Mass is `density × radius²` and `G = 560`, so surface gravity is the same on every
planet of a given material regardless of size — but a big planet has a far deeper well
to escape. That's what makes planet size read as difficulty at a glance.

## Multiplayer

Rooms are in-memory on the Node server. The first player into a room fixes the course
seed; everyone who joins later inherits it. Positions broadcast at ~20 Hz and render as
translucent ghosts with name tags. The room advances to the next hole once every player
has finished or pressed Ready.

Scoring is kept honest in a lobby: restarting a hole (`R`) carries your strokes over and
adds a penalty stroke instead of wiping the slate, and once you've holed out the
"Replay hole" button is hidden so a finished score can't be rewritten. Solo play keeps
the free restart.

## Career stats and achievements

Everything you do is tracked locally (`localStorage`, this device only — no accounts, no
server). Press `T` for the career sheet: furthest hole, holes sunk, aces, under-par
count, average strokes, best at-or-under-par streak, best run, shots, distance
travelled, longest single shot, bounces, balls lost, black-hole deaths, holes played
with friends, and time played — plus a full scorecard breakdown from ace to double bogey.

There are 17 achievements, from **First Light** (sink one hole) through **Long Bomb**
(a single shot over 5,000 units), **Grand Tour** (sink on rock, ice, lava and gas
worlds), **Spaghettified** (feed a ball to a black hole) and **Event Horizon** (reach
hole 30). Locked ones show a progress bar; unlocks pop a toast as they happen.

"Reset career" in the stats footer wipes stats and achievements after a confirmation.

## Recent players

A full friend list needs accounts, auth and a database, and the room server is
deliberately in-memory — so this is the account-free version. Everyone you share a room
with is saved locally: name, colour, how many sessions you've played together, the last
room code and when. Star someone to pin them to the top, hit **Join** to drop straight
back into the last room you shared, or **✕** to forget them.

The tradeoff is that identity is just a name — there's no way to tell two players with
the same name apart, and the list doesn't sync between your own devices. Upgrading to
real accounts later would mean adding auth and a database to the server.

## Tests

```bash
npm test         # headless generator + physics + stats checks, no browser
npm run build
npm run test:e2e # drives the real game in Chromium, two players, writes screenshots/
npm run audit    # samples 16k generated holes + 23k simulated shots, prints a report
```

`npm run audit` is the tool to reach for when changing generation or difficulty. It
reports cup-surface distribution per tier, hazard frequency, world sizes, and simulated
shot distances — which is how the achievement list was confirmed to be fully reachable.

`npm test` runs two headless suites. The course suite generates 150 courses and asserts
they're well-formed (no overlapping planets, cup never on a hazard, tee in bounds), that
the simulation is deterministic, that balls come to rest, and that holes are reachable.
The stats suite covers scoring buckets, streaks, penalties, best-run selection,
achievement unlocking, persistence and legacy migration, and the recent-players roster.

`npm run test:e2e` boots the server, plays a hole, sinks it, checks penalties and the
no-contact timer, opens the career sheet, reloads to confirm stats persist, then
connects two browsers to one room and verifies seed sync, ghosts, the roster, the
multiplayer restart penalty, and hole advancement — 44 checks, with screenshots.

## Layout

```
src/
  core/      seeded RNG, vector maths
  game/      generator, physics, settings, stats, friends, the Game orchestrator
  render/    camera, starfield, gravity field, particles, draw routines
  net/       WebSocket client + shared message types
  audio/     runtime-synthesised sound effects (no audio assets)
server/      static file server + WebSocket room server
test/        headless smoke test
scripts/     test runners
```

## Not built yet

Music, accounts and a real cross-device friend list, per-course leaderboards, replays,
and mobile UI polish beyond the basics.
