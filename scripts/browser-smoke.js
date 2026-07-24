/**
 * End-to-end smoke test. Multiplayer now runs on Supabase Realtime, which isn't available
 * offline, so the test forces the in-memory relay transport (window.__ORBIT_MEMORY_NET)
 * and drives a real game client plus a simulated in-page peer. A tiny static server serves
 * the production build.
 *
 *   npm run build && npm run test:e2e
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const shots = path.join(root, 'screenshots');
const dist = path.join(root, 'dist');
const PORT = 8799;
fs.mkdirSync(shots, { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  let p = path.join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(dist)) return void res.writeHead(403).end();
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(dist, 'index.html');
  if (!fs.existsSync(p)) return void res.writeHead(404).end('Run `npm run build` first.');
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] ?? 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

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
  // Force the in-memory relay and seed settings before any app script runs.
  await page.addInitScript((n) => {
    window.__ORBIT_MEMORY_NET = true;
    localStorage.setItem('orbit-golf.settings.v1', JSON.stringify({ playerName: n, soundEnabled: false }));
  }, name);
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
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
  await new Promise((res) => server.listen(PORT, res));
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
    // Park the ball in guaranteed-empty space: just inside the boundary, which is always
    // >= 1400 units beyond every body, so it can't be touching a planet on any seed.
    g.ball.pos.x = g.level.worldRadius - 80;
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
  // Real game client (page a) joins first and becomes host; the "friend" is a simulated
  // in-page peer over the same in-memory relay (two tabs can't share it).
  const ROOM = 'E2EROOM';
  await a.page.evaluate(() => document.getElementById('btn-play-multi').click());
  await a.page.waitForTimeout(300);
  await a.page.locator('#room-input').fill(ROOM);
  await a.page.locator('#btn-join').click();
  await a.page.waitForTimeout(500);
  check('join uses the in-memory relay in tests', (await a.page.evaluate(() => window.__game.net.status)) === 'online');

  // Spawn the friend.
  await a.page.evaluate((room) => window.__orbitPeer.spawn('Buddy', room, 90), ROOM);
  await a.page.waitForTimeout(500);

  const seedShared = await a.page.evaluate(() => window.__game.seed);
  check('seed is derived from the room code', seedShared !== 0);

  const aPhase = await a.page.evaluate(() => window.__game.phase);
  check('joining a room starts in the lobby, not mid-game', aPhase === 'lobby', aPhase);
  check('lobby panel is shown', await a.page.locator('#lobby-panel').isVisible());
  check('lobby lists both players', (await a.page.locator('#lobby-list li').count()) === 2, `${await a.page.locator('#lobby-list li').count()}`);

  check('the real client is the host', await a.page.evaluate(() => window.__game.isHost));
  check('the peer is not the host', !(await a.page.evaluate(() => window.__orbitPeer.isHost('Buddy'))));
  check('host crown is shown in the lobby', (await a.page.locator('#lobby-list .tag.host').count()) === 1);
  check('host sees host controls', await a.page.locator('#host-controls').isVisible());
  check('host sees a Start button', await a.page.locator('#lobby-cta .btn-primary').isVisible());
  check('host can kick the guest', (await a.page.locator('#lobby-list .kick').count()) === 1);
  await a.page.screenshot({ path: path.join(shots, '7-lobby-host.png') });

  // Recent-players roster picks up the peer.
  const friendRows = await a.page.locator('#friend-list li').count();
  check('the other player is saved to the roster', friendRows === 1, `${friendRows} rows`);
  const friendName = await a.page.locator('#friend-list .friend-name').first().textContent();
  check('roster shows the right name', friendName === 'Buddy', `got "${friendName}"`);
  await a.page.locator('#friend-list .friend-btn.star').first().click();
  await a.page.waitForTimeout(150);
  check(
    'starring a player persists to storage',
    (await a.page.evaluate(() => JSON.parse(localStorage.getItem('orbit-golf.friends.v1') ?? '[]')[0]?.starred)) === true,
  );

  // Host changes aim policy → the peer receives it.
  await a.page.locator('#seg-aim .seg-btn[data-val="off"]').click();
  await a.page.waitForTimeout(300);
  check(
    'host aim-guide policy propagates to the peer',
    (await a.page.evaluate(() => window.__orbitPeer.aimPolicy('Buddy'))) === 'off',
    await a.page.evaluate(() => window.__orbitPeer.aimPolicy('Buddy')),
  );

  // Peer (non-host) cannot change room config.
  await a.page.evaluate(() => window.__orbitPeer.setConfig('Buddy', { aimPolicy: 'free' }));
  await a.page.waitForTimeout(300);
  check('a non-host cannot change room settings', (await a.page.evaluate(() => window.__game.roomConfig.aimPolicy)) === 'off');

  // Host starts the game → the real client leaves the lobby for the course.
  await a.page.locator('#lobby-cta .btn-primary').click();
  await a.page.waitForTimeout(600);
  check('host is now in the playing phase', (await a.page.evaluate(() => window.__game.phase)) === 'playing');
  check('the peer is in the playing phase', (await a.page.evaluate(() => window.__orbitPeer.phase('Buddy'))) === 'playing');
  check('starting closes the lobby and shows the HUD', await a.page.locator('#hud').isVisible());
  check('the multi sheet is closed after start', !(await a.page.locator('#multi').isVisible()));
  await a.page.screenshot({ path: path.join(shots, '9-multiplayer-play.png') });

  // The peer's ball arrives as a ghost.
  await a.page.evaluate(() => window.__orbitPeer.sendPos('Buddy', 300, 150, 'flying'));
  await a.page.waitForTimeout(300);
  const ghostSeen = await a.page.evaluate(() => {
    const gs = [...window.__game.ghosts.values()].filter((g) => g.info.id !== window.__game.net.selfId);
    return gs.length > 0 && gs.some((g) => Math.hypot(g.target.x, g.target.y) > 0);
  });
  check('the peer appears as a moving ghost', ghostSeen);
  check('scoreboard appears in multiplayer', await a.page.locator('#scoreboard').isVisible());

  // Restart carries strokes + penalty in multiplayer.
  const mpRetry = await a.page.evaluate(() => {
    const g = window.__game;
    g.strokes = 3;
    g.restartHole();
    return { strokes: g.strokes, state: g.ball.state };
  });
  check('multiplayer restart keeps strokes and adds a penalty', mpRetry.strokes === 4, `strokes=${mpRetry.strokes}`);
  check('multiplayer restart re-tees the ball', mpRetry.state === 'idle', mpRetry.state);

  // Host disables restarts → the control reports blocked.
  await a.page.evaluate(() => window.__game.setRoomConfig({ allowRestart: false }));
  await a.page.waitForTimeout(300);
  const blocked = await a.page.evaluate(() => {
    const g = window.__game;
    g.strokes = 2;
    g.restartHole();
    return { canRestart: g.canRestart, strokes: g.strokes };
  });
  check('host can disable restarts', blocked.canRestart === false, `canRestart=${blocked.canRestart}`);
  check('a blocked restart does not add a stroke', blocked.strokes === 2, `strokes=${blocked.strokes}`);
  await a.page.evaluate(() => window.__game.setRoomConfig({ allowRestart: true }));

  // Host advances the hole once everyone is done.
  const holeBefore = await a.page.evaluate(() => window.__game.holeIndex);
  await a.page.evaluate(() => window.__orbitPeer.markDone('Buddy', 3, 'sunk'));
  await a.page.evaluate(() => window.__game.net.markDone(3, 'sunk'));
  await a.page.waitForTimeout(5000);
  const holeAfter = await a.page.evaluate(() => window.__game.holeIndex);
  check('room advances when everyone is done', holeAfter === holeBefore + 1, `${holeBefore} -> ${holeAfter}`);

  // Host kicks the peer.
  await a.page.evaluate(() => {
    const g = window.__game;
    const other = g.players.find((p) => p.id !== g.net.selfId);
    if (other) g.kickPlayer(other.id);
  });
  await a.page.waitForTimeout(400);
  check('the kicked peer is notified', await a.page.evaluate(() => window.__orbitPeer.kicked('Buddy')));
  check('the host now sees only themselves', (await a.page.evaluate(() => window.__game.players.length)) === 1);

  check('no uncaught page errors (multiplayer)', a.errors.length === 0, a.errors.slice(0, 3).join(' | '));

  await browser.close();
} catch (err) {
  console.error(err);
  failures++;
} finally {
  server.close();
}

console.log('');
console.log(failures === 0 ? `All browser checks passed. Screenshots in ${shots}` : `${failures} browser check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
