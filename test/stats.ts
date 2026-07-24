/**
 * Headless checks for career stats, achievements and the recent-players roster.
 * These modules touch localStorage, so a tiny in-memory shim stands in for it.
 */
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

const {
  ACHIEVEMENTS,
  averageStrokes,
  checkAchievements,
  formatDistance,
  formatDuration,
  loadStats,
  recordHole,
  recordPenalty,
  recordRun,
  recordShot,
  resetStats,
  saveStats,
  underPar,
} = await import('../src/game/stats');
const { loadFriends, rememberPlayers, toggleStar, forgetPlayer, saveFriends, relativeTime } =
  await import('../src/game/friends');

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) {
    failures++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('Orbit Golf — stats & roster checks\n');

const hole = (over: Partial<Parameters<typeof recordHole>[1]> = {}) => ({
  hole: 1,
  par: 3,
  strokes: 3,
  outcome: 'sunk' as const,
  tier: 'Easy' as const,
  cupSurface: 'rock' as const,
  multiplayer: false,
  ...over,
});

// --- scoring buckets ---------------------------------------------------------
{
  const s = resetStats();
  recordHole(s, hole({ strokes: 1 }));
  recordHole(s, hole({ strokes: 1, par: 4 }));
  recordHole(s, hole({ strokes: 2, par: 4 }));
  recordHole(s, hole({ strokes: 3, par: 4 }));
  recordHole(s, hole({ strokes: 4, par: 4 }));
  recordHole(s, hole({ strokes: 5, par: 4 }));
  recordHole(s, hole({ strokes: 9, par: 4 }));

  check('aces counted', s.aces === 2, `${s.aces}`);
  // strokes 1 vs par 3 is -2 (eagle); 1 vs par 4 is -3 (albatross).
  check('albatross counted', s.albatrosses === 1, `${s.albatrosses}`);
  check('eagle counted', s.eagles === 2, `${s.eagles}`);
  check('birdie counted', s.birdies === 1, `${s.birdies}`);
  check('par counted', s.pars === 1, `${s.pars}`);
  check('bogey counted', s.bogeys === 1, `${s.bogeys}`);
  check('double+ counted', s.worse === 1, `${s.worse}`);
  check('holes completed', s.holesCompleted === 7, `${s.holesCompleted}`);
  check('total strokes summed', s.totalStrokes === 1 + 1 + 2 + 3 + 4 + 5 + 9, `${s.totalStrokes}`);
  check('under par helper', underPar(s) === 4, `${underPar(s)}`);
  check('average strokes', Math.abs(averageStrokes(s) - 25 / 7) < 1e-9, `${averageStrokes(s)}`);
}

// --- streaks -----------------------------------------------------------------
{
  const s = resetStats();
  for (let i = 0; i < 4; i++) recordHole(s, hole({ strokes: 2 }));
  check('streak builds on under-par holes', s.currentStreak === 4, `${s.currentStreak}`);
  recordHole(s, hole({ strokes: 9 }));
  check('a bogey breaks the streak', s.currentStreak === 0, `${s.currentStreak}`);
  check('best streak is remembered', s.bestStreak === 4, `${s.bestStreak}`);
  recordHole(s, hole({ strokes: 3 }));
  check('par extends a streak', s.currentStreak === 1, `${s.currentStreak}`);
}

// --- concedes ----------------------------------------------------------------
{
  const s = resetStats();
  recordHole(s, hole({ strokes: 2 }));
  recordHole(s, hole({ outcome: 'skipped', strokes: 5 }));
  check('conceded hole counted', s.holesConceded === 1, `${s.holesConceded}`);
  check('conceded hole is not a completion', s.holesCompleted === 1, `${s.holesCompleted}`);
  check('conceding breaks the streak', s.currentStreak === 0, `${s.currentStreak}`);
  check('conceded strokes still count', s.totalStrokes === 7, `${s.totalStrokes}`);
}

// --- shots and penalties -----------------------------------------------------
{
  const s = resetStats();
  recordShot(s, 1200, 3);
  recordShot(s, 5400, 1);
  recordShot(s, 300, 0);
  check('shots counted', s.shots === 3, `${s.shots}`);
  check('bounces summed', s.bounces === 4, `${s.bounces}`);
  check('distance summed', s.totalDistance === 6900, `${s.totalDistance}`);
  check('longest shot tracked', s.longestShot === 5400, `${s.longestShot}`);

  recordPenalty(s, 'lost');
  recordPenalty(s, 'crush');
  recordPenalty(s, 'crush');
  recordPenalty(s, 'adrift');
  check('penalties bucketed', s.ballsLost === 1 && s.ballsCrushed === 2 && s.timesAdrift === 1);
}

// --- best run ----------------------------------------------------------------
{
  const s = resetStats();
  recordRun(s, 2, 6, -1);
  check('runs under 3 holes are ignored', s.bestRun === null);
  recordRun(s, 5, 20, 2);
  check('first qualifying run is recorded', s.bestRun?.relPar === 2, JSON.stringify(s.bestRun));
  recordRun(s, 4, 15, 5);
  check('a worse run does not overwrite', s.bestRun?.relPar === 2, JSON.stringify(s.bestRun));
  recordRun(s, 6, 22, -3);
  check('a better run overwrites', s.bestRun?.relPar === -3, JSON.stringify(s.bestRun));
  recordRun(s, 9, 33, -3);
  check('ties break toward more holes', s.bestRun?.holes === 9, JSON.stringify(s.bestRun));
}

// --- achievements ------------------------------------------------------------
{
  const s = resetStats();
  check('nothing unlocked on a fresh career', checkAchievements(s).length === 0);

  recordHole(s, hole({ strokes: 1 }));
  const first = checkAchievements(s).map((a) => a.id);
  check('first hole unlocks First Light and Hole in One', first.includes('first-light') && first.includes('ace'), first.join(','));
  check('unlocks are not re-announced', checkAchievements(s).length === 0);

  recordHole(s, hole({ strokes: 1 }));
  recordHole(s, hole({ strokes: 1 }));
  check('third ace unlocks Sharpshooter', checkAchievements(s).some((a) => a.id === 'ace-3'));

  recordShot(s, 6000, 0);
  check('a 6000-unit shot unlocks Long Bomb', checkAchievements(s).some((a) => a.id === 'long-bomb'));

  for (const k of ['rock', 'ice', 'lava', 'gas'] as const) {
    recordHole(s, hole({ strokes: 3, cupSurface: k }));
  }
  check('sinking on all four surfaces unlocks Grand Tour', checkAchievements(s).some((a) => a.id === 'grand-tour'));

  recordHole(s, hole({ hole: 30, strokes: 3 }));
  const deep = checkAchievements(s).map((a) => a.id);
  check('reaching hole 30 unlocks all three depth tiers', ['reach-10', 'reach-20', 'reach-30'].every((id) => deep.includes(id)), deep.join(','));

  check('every achievement has a unique id', new Set(ACHIEVEMENTS.map((a) => a.id)).size === ACHIEVEMENTS.length);
  check('every achievement has a positive goal', ACHIEVEMENTS.every((a) => a.goal > 0));
}

// --- persistence and migration ----------------------------------------------
{
  const s = resetStats();
  recordHole(s, hole({ hole: 7, strokes: 2 }));
  recordShot(s, 999, 2);
  checkAchievements(s);
  saveStats(s);

  const reloaded = loadStats();
  check('stats survive a reload', reloaded.furthestHole === 7 && reloaded.holesCompleted === 1, JSON.stringify({ h: reloaded.furthestHole, c: reloaded.holesCompleted }));
  check('achievements survive a reload', Boolean(reloaded.achievements['first-light']));
  check('longest shot survives a reload', reloaded.longestShot === 999, `${reloaded.longestShot}`);

  store.clear();
  localStorage.setItem('orbit-golf.progress.v1', JSON.stringify({ furthestHole: 12, totalStrokes: 88, holesPlayed: 20 }));
  const migrated = loadStats();
  check('legacy progress is migrated', migrated.furthestHole === 12 && migrated.totalStrokes === 88 && migrated.holesPlayed === 20, JSON.stringify(migrated.furthestHole));
  store.clear();
}

// --- formatting --------------------------------------------------------------
{
  check('distance formats thousands', formatDistance(1500) === '1.5k', formatDistance(1500));
  check('distance formats millions', formatDistance(2_500_000) === '2.50M', formatDistance(2_500_000));
  check('distance formats small values', formatDistance(420) === '420', formatDistance(420));
  check('duration formats hours', formatDuration(3725) === '1h 2m', formatDuration(3725));
  check('duration formats minutes', formatDuration(125) === '2m 5s', formatDuration(125));
  check('duration formats seconds', formatDuration(42) === '42s', formatDuration(42));
}

// --- recent players ----------------------------------------------------------
{
  store.clear();
  let list = loadFriends();
  check('roster starts empty', list.length === 0);

  const session = new Set<string>();
  list = rememberPlayers(list, [{ name: 'Ada', hue: 200 }, { name: 'Grace', hue: 90 }], 'NEBULA', session);
  check('both players remembered', list.length === 2, `${list.length}`);
  check('meeting counted once', list.every((f) => f.meetings === 1), JSON.stringify(list.map((f) => f.meetings)));

  // Repeated broadcasts in the same session must not inflate the tally.
  list = rememberPlayers(list, [{ name: 'Ada', hue: 200 }], 'NEBULA', session);
  check('repeat broadcast does not double count', list.find((f) => f.key === 'ada')?.meetings === 1, `${list.find((f) => f.key === 'ada')?.meetings}`);

  list = rememberPlayers(list, [{ name: 'Ada', hue: 200 }], 'PULSAR', new Set());
  const ada = list.find((f) => f.key === 'ada');
  check('a new session increments meetings', ada?.meetings === 2, `${ada?.meetings}`);
  check('last room is updated', ada?.lastRoom === 'PULSAR', ada?.lastRoom);

  check('name matching is case insensitive', rememberPlayers(list, [{ name: 'ADA', hue: 1 }], 'X', new Set()).filter((f) => f.key === 'ada').length === 1);

  list = toggleStar(list, 'grace');
  check('starred player sorts first', list[0].key === 'grace', list[0].key);
  check('star is set', list[0].starred === true);
  list = toggleStar(list, 'grace');
  check('star toggles back off', list.find((f) => f.key === 'grace')?.starred === false);

  saveFriends(list);
  check('roster persists', loadFriends().length === list.length);

  list = forgetPlayer(list, 'ada');
  check('forget removes a player', !list.some((f) => f.key === 'ada'), `${list.length} left`);

  check('relative time reads "just now"', relativeTime(Date.now()) === 'just now');
  check('relative time reads minutes', relativeTime(Date.now() - 5 * 60_000) === '5m ago', relativeTime(Date.now() - 5 * 60_000));
  check('relative time reads hours', relativeTime(Date.now() - 3 * 3600_000) === '3h ago', relativeTime(Date.now() - 3 * 3600_000));
}

console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log('All stats & roster checks passed.');
}
