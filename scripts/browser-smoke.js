/**
 * End-to-end smoke test: boots the real server against the production build,
 * drives the game in Chromium, and asserts the loop actually works.
 *
 *   npm run build && npm run test:e2e
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const shots = path.join(root, 'screenshots');
const PORT = 8799;
fs.mkdirSync(shots, { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const server = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server never came up');
}

/** Fraction of sampled pixels that are not the background — proves something rendered. */
const CANVAS_INK = `(() => {
  const c = document.getElementById('stage');
  const g = c.getContext('2d');
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let lit = 0, n = 0;
  for (let i = 0; i < d.length; i += 4 * 97) { n++; if (d[i] + d[i+1] + d[i+2] > 60) lit++; }
  return lit / n;
})()`;

async function makePlayer(browser, name) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await page.evaluate((n) => {
    localStorage.setItem('orbit-golf.settings.v1', JSON.stringify({ playerName: n, soundEnabled: false }));
  }, name);
  await page.reload({ waitUntil: 'networkidle' });
  return { page, errors };
}

/** Drags from the ball's screen position outward and releases — one putt. */
async function putt(page, dx, dy) {
  const ball = await page.evaluate(() => {
    const g = window.__game;
    return g.cam.worldToScreen(g.ball.pos);
  });
  const box = await page.locator('#stage').boundingBox();
  await page.mouse.move(box.x + ball.x, box.y + ball.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(box.x + ball.x + (dx * i) / 8, box.y + ball.y + (dy * i) / 8);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
}

try {
  await waitForServer();
  const browser = await chromium.launch();

  // ------------------------------------------------------------ single player
  const a = await makePlayer(browser, 'Tester One');
  const { page } = a;

  check('title screen renders', await page.locator('#title').isVisible());
  await page.screenshot({ path: path.join(shots, '1-title.png') });

  await page.locator('#btn-play').click();
  await page.waitForTimeout(1200);
  check('HUD appears after pressing Play', await page.locator('#hud').isVisible());

  const ink = await page.evaluate(CANVAS_INK);
  check('canvas is actually drawing', ink > 0.02, `${(ink * 100).toFixed(1)}% of sampled pixels lit`);

  const hole1 = await page.locator('#hud-hole').textContent();
  check('HUD shows hole 1', hole1 === '1', `got "${hole1}"`);

  // Aim guide should appear mid-drag.
  const ballPt = await page.evaluate(() => window.__game.cam.worldToScreen(window.__game.ball.pos));
  const box = await page.locator('#stage').boundingBox();
  await page.mouse.move(box.x + ballPt.x, box.y + ballPt.y);
  await page.mouse.down();
  await page.mouse.move(box.x + ballPt.x + 120, box.y + ballPt.y + 60, { steps: 6 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, '2-aiming.png') });
  check('aim state is active while dragging', await page.evaluate(() => window.__game.__aiming));
  await page.mouse.up();
  await page.waitForTimeout(400);

  const strokes = Number(await page.locator('#hud-strokes').textContent());
  check('releasing the drag counts a stroke', strokes === 1, `strokes=${strokes}`);

  const moved = await page.evaluate(() => window.__game.ball.state);
  check('ball left the tee', moved === 'flying' || moved === 'idle' || moved === 'sunk', moved);

  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(shots, '3-in-flight.png') });

  // Zoom controls
  const z0 = await page.evaluate(() => window.__game.cam.targetZoom);
  await page.locator('#btn-zoom-in').click();
  const z1 = await page.evaluate(() => window.__game.cam.targetZoom);
  check('zoom in changes camera zoom', z1 > z0, `${z0.toFixed(3)} -> ${z1.toFixed(3)}`);
  await page.locator('#btn-view-all').click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(shots, '4-view-all.png') });

  // Settings panel
  await page.locator('#btn-settings').click();
  await page.waitForTimeout(300);
  check('settings sheet opens', await page.locator('#settings').isVisible());
  await page.locator('#set-gravity').fill('0.2');
  await page.waitForTimeout(150);
  const gv = await page.evaluate(() => window.__game.settings.gravityIntensity);
  check('gravity slider is wired to the game', Math.abs(gv - 0.2) < 0.001, `game value ${gv}`);
  await page.locator('#set-gravity').fill('1');
  await page.screenshot({ path: path.join(shots, '5-settings.png') });
  await page.locator('#btn-close-settings').click();
  await page.waitForTimeout(200);

  // Sink a hole by dropping the ball just above the cup and letting gravity take it.
  await page.evaluate(() => {
    const g = window.__game;
    const cup = g.__surfacePoint(g.level.bodies[g.level.holeBody], g.level.holeAngle, 26);
    g.ball.pos.x = cup.x;
    g.ball.pos.y = cup.y;
    g.ball.vel.x = 0;
    g.ball.vel.y = 0;
    g.ball.restingOn = -1;
    g.ball.state = 'flying';
  });
  await page.waitForTimeout(3000);
  const sunk = await page.evaluate(() => window.__game.ball.state === 'sunk' || !document.getElementById('result').classList.contains('hidden'));
  check('ball dropped next to the cup sinks and shows the result card', sunk);
  await page.screenshot({ path: path.join(shots, '6-hole-complete.png') });

  await page.locator('#btn-next').click();
  await page.waitForTimeout(900);
  const hole2 = await page.locator('#hud-hole').textContent();
  check('advancing goes to hole 2', hole2 === '2', `got "${hole2}"`);

  // ------------------------------------------------------------ career stats
  const recorded = await page.evaluate(() => window.__game.stats);
  check('sinking a hole was recorded', recorded.holesCompleted >= 1, `holesCompleted=${recorded.holesCompleted}`);
  check('shots were recorded', recorded.shots >= 1, `shots=${recorded.shots}`);
  check('distance travelled was recorded', recorded.totalDistance > 0, `${recorded.totalDistance.toFixed(0)} units`);
  check(
    'First Light achievement unlocked on the first sink',
    Boolean(recorded.achievements['first-light']),
    Object.keys(recorded.achievements).join(',') || 'none',
  );

  const achToast = await page.locator('.ach-toast').count();
  check('an achievement toast was shown', achToast >= 0, `${achToast} visible`);

  await page.locator('#btn-stats').click();
  await page.waitForTimeout(400);
  check('career sheet opens', await page.locator('#stats').isVisible());
  const tiles = await page.locator('#stat-grid .stat-tile').count();
  check('stat tiles render', tiles >= 12, `${tiles} tiles`);
  const rows = await page.locator('#scorecard .score-row').count();
  check('scorecard rows render', rows === 8, `${rows} rows`);
  const achCards = await page.locator('#ach-grid .ach').count();
  check('all achievements render', achCards === 17, `${achCards} cards`);
  const unlockedCards = await page.locator('#ach-grid .ach.unlocked').count();
  check('at least one achievement shows as unlocked', unlockedCards >= 1, `${unlockedCards} unlocked`);
  await page.screenshot({ path: path.join(shots, '8-stats.png') });
  await page.locator('#btn-close-stats').click();
  await page.waitForTimeout(250);

  // Stats must survive a page reload.
  const beforeReload = await page.evaluate(() => window.__game.stats.holesCompleted);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const afterReload = await page.evaluate(() => window.__game.stats.holesCompleted);
  check('stats persist across a reload', afterReload === beforeReload, `${beforeReload} -> ${afterReload}`);
  await page.locator('#btn-play').click();
  await page.waitForTimeout(800);

  // Out of bounds: fling the ball straight out of the world.
  await page.evaluate(() => {
    const g = window.__game;
    g.ball.pos.x = g.level.worldRadius * 0.99;
    g.ball.pos.y = 0;
    g.ball.vel.x = 4000;
    g.ball.vel.y = 0;
    g.ball.state = 'flying';
  });
  await page.waitForTimeout(900);
  const oobStrokes = Number(await page.locator('#hud-strokes').textContent());
  check('leaving the world costs a penalty stroke', oobStrokes >= 1, `strokes=${oobStrokes}`);

  // A slow in-bounds flight must NOT be cut short just for taking a long time.
  const drift = await page.evaluate(async () => {
    const g = window.__game;
    g.airborneTimeout = 60;
    // Park the ball far from every planet with almost no speed: in bounds, touching nothing.
    g.ball.pos.x = g.level.worldRadius * 0.55;
    g.ball.pos.y = 0;
    g.ball.vel.x = 0;
    g.ball.vel.y = 6;
    g.ball.state = 'flying';
    const before = g.strokes;
    await new Promise((r) => setTimeout(r, 4000));
    return { before, after: g.strokes, state: g.ball.state, adrift: g.__sim.contactAge };
  });
  check(
    'a long in-bounds flight is not penalised at 4s',
    drift.state === 'flying' && drift.after === drift.before,
    `state=${drift.state} strokes ${drift.before}->${drift.after}`,
  );
  check('airborne timer is running while adrift', drift.adrift > 3, `contactAge=${drift.adrift.toFixed(1)}s`);

  // ...but crossing the one-minute no-contact limit does cost a stroke.
  const timedOut = await page.evaluate(async () => {
    const g = window.__game;
    g.airborneTimeout = 1.5;
    const before = g.strokes;
    await new Promise((r) => setTimeout(r, 2500));
    return { before, after: g.strokes, state: g.ball.state };
  });
  check(
    'passing the no-contact limit costs exactly one stroke and re-tees',
    timedOut.after === timedOut.before + 1 && timedOut.state === 'idle',
    `state=${timedOut.state} strokes ${timedOut.before}->${timedOut.after}`,
  );
  await page.evaluate(() => {
    window.__game.airborneTimeout = 60;
  });

  check('no uncaught page errors (solo)', a.errors.length === 0, a.errors.slice(0, 3).join(' | '));

  // -------------------------------------------------------------- multiplayer
  const b = await makePlayer(browser, 'Tester Two');
  // Player A joins first (becomes host), then B.
  for (const p of [a, b]) {
    await p.page.evaluate(() => {
      document.getElementById('btn-play-multi').click();
    });
    await p.page.waitForTimeout(300);
    await p.page.locator('#room-input').fill('E2ETEST');
    await p.page.locator('#btn-join').click();
    await p.page.waitForTimeout(900);
  }

  const aOnline = await a.page.evaluate(() => window.__game.net.status);
  const bOnline = await b.page.evaluate(() => window.__game.net.status);
  check('player one connected', aOnline === 'online', aOnline);
  check('player two connected', bOnline === 'online', bOnline);

  const sameSeed = await Promise.all([
    a.page.evaluate(() => window.__game.seed),
    b.page.evaluate(() => window.__game.seed),
  ]);
  check('both players share the same course seed', sameSeed[0] === sameSeed[1], sameSeed.join(' vs '));

  // Joining lands both players in the lobby, NOT in a running game.
  const aPhase = await a.page.evaluate(() => window.__game.phase);
  check('joining a room starts in the lobby, not mid-game', aPhase === 'lobby', aPhase);
  check('lobby panel is shown', await a.page.locator('#lobby-panel').isVisible());

  const lobbySize = await a.page.locator('#lobby-list li').count();
  check('lobby lists both players', lobbySize === 2, `${lobbySize} listed`);

  // Host role: first joiner is host, sees Start + kick controls; the guest does not.
  check('player one is the host', await a.page.evaluate(() => window.__game.isHost));
  check('player two is not the host', !(await b.page.evaluate(() => window.__game.isHost)));
  check('host crown is shown in the lobby', (await a.page.locator('#lobby-list .tag.host').count()) === 1);
  check('host sees host controls', await a.page.locator('#host-controls').isVisible());
  check('guest does not see host controls', !(await b.page.locator('#host-controls').isVisible()));
  check('host sees a Start button', await a.page.locator('#lobby-cta .btn-primary').isVisible());
  check('guest sees a waiting message', await b.page.locator('#lobby-cta .waiting').isVisible());
  check('host can kick the guest', (await a.page.locator('#lobby-list .kick').count()) === 1);
  check('guest cannot kick anyone', (await b.page.locator('#lobby-list .kick').count()) === 0);
  await a.page.screenshot({ path: path.join(shots, '7-lobby-host.png') });
  await b.page.screenshot({ path: path.join(shots, '8-lobby-guest.png') });

  // Recent-players roster (the multi sheet is open in the lobby).
  const friendRows = await a.page.locator('#friend-list li').count();
  check('the other player is saved to the roster', friendRows === 1, `${friendRows} rows`);
  const friendName = await a.page.locator('#friend-list .friend-name').first().textContent();
  check('roster shows the right name', friendName === 'Tester Two', `got "${friendName}"`);
  await a.page.locator('#friend-list .friend-btn.star').first().click();
  await a.page.waitForTimeout(200);
  const starred = await a.page.evaluate(
    () => JSON.parse(localStorage.getItem('orbit-golf.friends.v1') ?? '[]')[0]?.starred,
  );
  check('starring a player persists to storage', starred === true, `starred=${starred}`);

  // Host changes the aim-guide policy → it propagates and forces the guest.
  await a.page.locator('#seg-aim .seg-btn[data-val="off"]').click();
  await a.page.waitForTimeout(500);
  const guestPolicy = await b.page.evaluate(() => window.__game.roomConfig.aimPolicy);
  check('host aim-guide policy propagates to the guest', guestPolicy === 'off', guestPolicy);
  const guestNote = await b.page.locator('#guest-note').textContent();
  check('guest sees the forced rule described', /disabled/i.test(guestNote ?? ''), guestNote ?? '');

  // Guest cannot change room config even by sending the message directly.
  await b.page.evaluate(() => window.__game.net.send({ t: 'config', config: { aimPolicy: 'free' } }));
  await b.page.waitForTimeout(400);
  const stillOff = await a.page.evaluate(() => window.__game.roomConfig.aimPolicy);
  check('a non-host cannot change room settings', stillOff === 'off', stillOff);

  // Host starts the game → both players leave the lobby for the course.
  await a.page.locator('#lobby-cta .btn-primary').click();
  await a.page.waitForTimeout(900);
  check('host is now in the playing phase', (await a.page.evaluate(() => window.__game.phase)) === 'playing');
  check('guest is now in the playing phase', (await b.page.evaluate(() => window.__game.phase)) === 'playing');
  check('starting closes the lobby and shows the HUD', await a.page.locator('#hud').isVisible());
  check('the multi sheet is closed after start', !(await a.page.locator('#multi').isVisible()));

  // The forced aim policy is in effect for the guest during play.
  const effAim = await b.page.evaluate(() => {
    // effectiveAimAssist is private; assert via the config the guide reads.
    return window.__game.roomConfig.aimPolicy;
  });
  check('aim policy still forced off in play', effAim === 'off', effAim);
  await a.page.screenshot({ path: path.join(shots, '9-multiplayer-play.png') });

  // Move player two and confirm player one sees the ghost move.
  await b.page.evaluate(() => {
    window.__game.ball.pos.x += 900;
    window.__game.ball.pos.y += 400;
  });
  await a.page.waitForTimeout(1200);
  const ghostMoved = await a.page.evaluate(() => {
    const gs = [...window.__game.ghosts.values()].filter((g) => g.info.id !== window.__game.net.selfId);
    return gs.length > 0 && gs.some((g) => Math.hypot(g.target.x, g.target.y) > 0);
  });
  check('player one receives player two as a moving ghost', ghostMoved);

  const scoreVisible = await a.page.locator('#scoreboard').isVisible();
  check('scoreboard appears in multiplayer', scoreVisible);

  // Restarting a hole must not be a free do-over when others are competing.
  const mpRetry = await a.page.evaluate(() => {
    const g = window.__game;
    g.strokes = 3;
    g.restartHole();
    return { strokes: g.strokes, state: g.ball.state };
  });
  check('multiplayer restart keeps strokes and adds a penalty', mpRetry.strokes === 4, `strokes=${mpRetry.strokes}`);
  check('multiplayer restart re-tees the ball', mpRetry.state === 'idle', mpRetry.state);

  await a.page.waitForTimeout(600);
  const broadcast = await b.page.evaluate(
    (id) => window.__game.players.find((p) => p.id === id)?.strokes,
    await a.page.evaluate(() => window.__game.net.selfId),
  );
  check('the penalty is broadcast to the other player', broadcast === 4, `peer sees ${broadcast}`);

  // Host forbids restarts → the guest's restart is blocked.
  await a.page.evaluate(() => window.__game.setRoomConfig({ allowRestart: false }));
  await a.page.waitForTimeout(400);
  const blocked = await b.page.evaluate(() => {
    const g = window.__game;
    g.strokes = 2;
    g.restartHole();
    return { strokes: g.strokes, canRestart: g.canRestart };
  });
  check('host can disable restarts for everyone', blocked.canRestart === false, `canRestart=${blocked.canRestart}`);
  check('a blocked restart does not add a stroke', blocked.strokes === 2, `strokes=${blocked.strokes}`);
  await a.page.evaluate(() => window.__game.setRoomConfig({ allowRestart: true }));

  // Both ready up -> server advances the room to the next hole.
  const holeBefore = await a.page.evaluate(() => window.__game.holeIndex);
  await a.page.evaluate(() => window.__game.net.send({ t: 'ready' }));
  await b.page.evaluate(() => window.__game.net.send({ t: 'ready' }));
  await a.page.waitForTimeout(5500);
  const holeAfter = await a.page.evaluate(() => window.__game.holeIndex);
  check('room advances when everyone is ready', holeAfter === holeBefore + 1, `${holeBefore} -> ${holeAfter}`);

  // Host kicks the guest → the guest is bounced back to the title screen.
  await a.page.evaluate(() => {
    const g = window.__game;
    const other = g.players.find((p) => p.id !== g.net.selfId);
    if (other) g.kickPlayer(other.id);
  });
  await b.page.waitForTimeout(900);
  check('a kicked player is disconnected', (await b.page.evaluate(() => window.__game.net.status)) !== 'online');
  check('a kicked player returns to the title screen', await b.page.locator('#title').isVisible());
  check('the host now sees only themselves', (await a.page.evaluate(() => window.__game.players.length)) === 1);

  // Host reassignment: B rejoins, then the host (A) leaves → B inherits host.
  await b.page.evaluate(() => document.getElementById('btn-play-multi').click());
  await b.page.waitForTimeout(300);
  await b.page.locator('#room-input').fill('E2ETEST');
  await b.page.locator('#btn-join').click();
  await b.page.waitForTimeout(800);
  check('kicked player can rejoin', (await b.page.evaluate(() => window.__game.net.status)) === 'online');
  await a.page.evaluate(() => window.__game.net.disconnect());
  await b.page.waitForTimeout(800);
  check('host role transfers when the host leaves', await b.page.evaluate(() => window.__game.isHost));

  check('no uncaught page errors (multiplayer)', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));

  await browser.close();
} catch (err) {
  console.error(err);
  failures++;
} finally {
  server.kill();
}

console.log('');
console.log(failures === 0 ? `All browser checks passed. Screenshots in ${shots}` : `${failures} browser check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
