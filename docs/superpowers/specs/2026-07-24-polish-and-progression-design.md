# Polish & Progression — Design

Date: 2026-07-24
Status: Approved for planning

## Goal

Ship the first post-launch update for Orbit Golf as a **small, low-risk bundle** in the
"polish & accessibility" direction, plus a light progression layer. The overriding
constraint from the maintainer: **do not destabilize the working base.** Every feature
here is additive and isolated. Nothing in this update touches `generator.ts`,
`physics.ts`, or hole-advancement logic, so the determinism contract, the physics-scale
balance, and the multiplayer advancement rules are all left exactly as they are.

## Scope

Four features, ordered from lowest to highest risk:

- **A. Ambient music** — synthesized ambient layer in the audio module.
- **B. Colorblind mode** — accessible aim-guide palette + optional outcome labels.
- **C. Cosmetics + currency** — earn a local currency by playing well; spend it on ball
  skins/trails; equipped skin is visible to other players in multiplayer.

### Explicitly out of scope (YAGNI)

- No server-side wallet or leaderboards — currency is device-local like all other state.
- No image/audio assets — everything stays runtime-synthesized / code-defined.
- No changes to course generation, physics, achievements balance, or the multiplayer
  advancement/host-election path.

## Design decisions locked during brainstorming

1. Currency is **local-only** (localStorage), matching the account-free design. Because
   there is no server and no leaderboard, farming only affects your own wallet — there is
   no exploit surface, so earn rules can be simple and generous.
2. Skins/trails are **code-defined** (colors, gradients, trail parameters), not assets.
3. Equipped skin **is broadcast** so other players see it on your ghost — via a single
   static field on Presence player meta, never in the position hot path.

---

## Feature A — Ambient music

**Where:** `src/audio/` (new `music.ts` sibling to `sfx.ts`, or an added section of
`sfx.ts` — implementer's call; keep it self-contained).

**What:** A generative, looping ambient layer (pad + slow arpeggio) synthesized at
runtime via WebAudio, consistent with the existing no-asset SFX approach. Starts on the
first user interaction to satisfy browser autoplay policy. Loops indefinitely with light
variation so it doesn't need a fixed audio file.

**Settings:** A new **Music volume** control in the Settings panel, independent from the
existing SFX volume. Persisted via `settings.ts` (new field, defaulted so existing saved
settings still load). Music off = volume 0.

**Isolation:** No consumer outside the audio module and the settings read. No game-loop,
render, or net changes.

---

## Feature B — Colorblind mode

**Where:** `settings.ts` (toggle) + the render path that draws the aim-guide trajectory.

**What today:** The dotted aim guide encodes predicted outcome by color only —
green = sink, blue = still flying, orange = leaves map, red = black hole. Color is the
sole channel, which fails for colorblind players.

**Change:** A **Colorblind mode** toggle in Settings that, when on:
- Swaps the four outcome colors for an accessible palette (higher luminance contrast,
  distinguishable under common CVD types).
- Optionally renders a short label at the trajectory's end point:
  `SINK` / `FLY` / `OUT` / `HOLE`.

**Constraint:** This changes only *how the prediction is displayed*, never what
`predictTrajectory` computes. The prediction remains the single shared real simulation.
Read the setting in the render/draw code; do not fork prediction logic.

**Persistence:** New boolean in `settings.ts`, defaulted off.

---

## Feature C — Cosmetics + currency

### C1 — Currency module

**Where:** New module `src/game/cosmetics.ts`, following the established persistence
pattern (three independent localStorage modules, each with its own key and `load`/`save`).
This becomes the fourth such module.

**State shape (localStorage):**
```
{
  balance: number,        // current spendable currency ("Stardust")
  owned: string[],        // ids of purchased skins
  equipped: string | null // id of the equipped skin, or null = default
}
```
Own key, own `load`/`save`, own defaults/migration guard for absent fields. Nothing
outside this module reads or writes its storage key.

### C2 — Earning (skill-weighted)

Currency is awarded on **genuine hole completion** (holing out), scaled by performance
using values `stats.ts` already computes. Indicative formula (final numbers tuned during
implementation):

- Base award for sinking the hole.
- Bonus for finishing at or under par; larger bonus for under par.
- Ace bonus.
- Small bonuses for a long single shot and for completing without a black-hole death.

Awards surface as a small toast, reusing the existing achievement-toast UI pattern.

Because currency is local-only, no anti-farm mechanism is required. The award hooks into
the existing hole-complete callback path (`onHoleComplete`) rather than into physics or
advancement.

### C3 — Shop + selection UI

**Where:** A new panel in `index.html` / `main.ts`, using the same
`getElementById` + `addEventListener` style as existing screens (no framework).

**What:** Lists available skins/trails, each showing price, owned/equipped state, and a
running balance readout. Actions:
- **Buy** — if `balance >= price` and not owned: deduct balance, add to `owned`.
- **Equip** — set `equipped` to an owned skin (or back to default).

Reachable from Settings or a dedicated hotkey/button (implementer's choice, consistent
with existing screen entry points).

### C4 — Rendering the skin

**Where:** `src/render/` ball-drawing code.

**What:** The equipped skin/trail (read from the cosmetics module) styles the player's own
ball — color/gradient body and trail parameters. Skins are code-defined; default skin
matches today's appearance so an unequipped state is unchanged.

### C5 — Multiplayer visibility (Presence)

**Where:** `src/net/protocol.ts` (one additive field) + the Presence read in
`realtime.ts` + ghost rendering.

**What:** Add the equipped skin id as a **static field on the Presence player meta** —
set once on join and whenever the player re-equips, not sent in the position broadcast
hot path and **not** part of `RoomMeta`. This keeps it out of the rate-budget-sensitive
position/ready signalling described in the multiplayer notes.

Other clients read this field to style your ghost. **Fallback:** when the field is absent
(older client, transient Presence gap), ghost rendering uses the current default
appearance. No change to host election, hole advancement, the `state` broadcast, or the
anti-spoofing boundary.

---

## Testing & verification

- **`test/cosmetics.ts`** (new headless suite, added to the `suites` array in
  `scripts/run-tests.js`): currency award math per outcome, buy/equip transitions,
  insufficient-balance rejection, persistence round-trip, and default/migration when
  fields are absent. Mirrors how `stats.ts` is tested.
- **`test/multiplayer.ts`** (one added case): a peer's equipped-skin field propagates via
  Presence and is readable; a peer with the field absent falls back to default without
  error.
- **Regression guard:** No edits to `generator.ts`, `physics.ts`, or advancement. Run
  `npm test`, `npm run build`, and `npm run test:e2e` before shipping. `npm run audit` is
  unaffected but can be spot-run to confirm generation output is byte-identical.

## Risk summary

| Feature | Files touched | Risk |
| --- | --- | --- |
| A. Music | `audio/`, `settings.ts`, Settings UI | Very low — isolated audio |
| B. Colorblind | `settings.ts`, render draw path, Settings UI | Very low — display-only |
| C1–C4 Cosmetics/currency | new `cosmetics.ts`, `main.ts`/`index.html`, `render/`, `onHoleComplete` hook | Low — new isolated subsystem |
| C5 Presence broadcast | `protocol.ts`, `realtime.ts`, ghost render | Low-medium — one additive static Presence field, with fallback |

The only part that reaches into the tuned multiplayer code is C5, and it is confined to a
single additive, optional field with a safe absent-value fallback.
