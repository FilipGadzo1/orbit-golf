import './styles.css';
import { music } from './audio/music';
import { sfx } from './audio/sfx';
import { hashString } from './core/rng';
import { Game, type HoleResult } from './game/game';
import { tierFor } from './game/generator';
import {
  forgetPlayer,
  loadFriends,
  relativeTime,
  rememberPlayers,
  saveFriends,
  toggleStar,
  type KnownPlayer,
} from './game/friends';
import { loadSettings, randomName, saveSettings, type Settings } from './game/settings';
import { awardFor, buy, equip, grant, loadCosmetics, saveCosmetics, skinById, SKINS } from './game/cosmetics';
import {
  ACHIEVEMENTS,
  averageStrokes,
  formatDistance,
  formatDuration,
  resetStats,
  saveStats,
  underPar,
  type Achievement,
} from './game/stats';
import { isMultiplayerConfigured } from './net/config';
import type { AimPolicy, PlayerInfo, RoomPhase } from './net/protocol';
import { RealtimeClient, type NetStatus } from './net/realtime';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const settings: Settings = loadSettings();
const cosmetics = loadCosmetics();

function applyEquippedSkin(): void {
  const sk = skinById(cosmetics.equipped);
  game.ballSkin = { body: sk.body, glow: sk.glow };
}
const canvas = $<HTMLCanvasElement>('stage');
const game = new Game(canvas, settings);
applyEquippedSkin();

const els = {
  hud: $('hud'),
  title: $('title'),
  result: $('result'),
  settings: $('settings'),
  multi: $('multi'),
  toast: $('toast'),
  hole: $('hud-hole'),
  par: $('hud-par'),
  strokes: $('hud-strokes'),
  total: $('hud-total'),
  tier: $('hud-tier'),
  scoreboard: $('scoreboard'),
  scoreList: $<HTMLUListElement>('score-list'),
  roomLabel: $('room-label'),
  netDot: $('net-dot'),
  netLine: $('net-line'),
  lobbyPanel: $('lobby-panel'),
  lobbyPhase: $('lobby-phase'),
  lobbyList: $<HTMLUListElement>('lobby-list'),
  hostControls: $('host-controls'),
  segAim: $('seg-aim'),
  cfgRestart: $<HTMLInputElement>('cfg-restart'),
  guestNote: $('guest-note'),
  lobbyCta: $('lobby-cta'),
  seedInput: $<HTMLInputElement>('seed-input'),
  roomInput: $<HTMLInputElement>('room-input'),
  progressLine: $('progress-line'),
  stats: $('stats'),
  statGrid: $('stat-grid'),
  scorecard: $('scorecard'),
  achGrid: $('ach-grid'),
  achCount: $('ach-count'),
  achToasts: $('ach-toasts'),
  friendList: $<HTMLUListElement>('friend-list'),
  shop: $('shop'),
  shopBalance: $('shop-balance'),
  shopList: $('shop-list'),
  wait: $('wait'),
  waitReady: $<HTMLUListElement>('wait-ready'),
  waitPlaying: $<HTMLUListElement>('wait-playing'),
  waitMsg: $('wait-msg'),
  btnAdvance: $<HTMLButtonElement>('btn-advance'),
  hudReady: $('hud-ready'),
};

let toastTimer = 0;
function toast(message: string): void {
  els.toast.textContent = message;
  els.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => els.toast.classList.add('hidden'), 2800);
}

// ------------------------------------------------------------------ screens

type Screen = 'title' | 'game' | 'result' | 'settings' | 'multi' | 'stats' | 'shop' | 'wait';
let inGame = false;

function show(el: HTMLElement, visible: boolean): void {
  el.classList.toggle('hidden', !visible);
}

function openScreen(screen: Screen): void {
  show(els.title, screen === 'title');
  show(els.result, screen === 'result');
  show(els.settings, screen === 'settings');
  show(els.multi, screen === 'multi');
  show(els.stats, screen === 'stats');
  show(els.shop, screen === 'shop');
  show(els.wait, screen === 'wait');
  show(els.hud, inGame);
  if (screen === 'stats') renderStats();
  if (screen === 'shop') renderShop();
  if (screen === 'multi') updateMultiConfigNotice();
  canvas.style.cursor = screen === 'game' ? 'crosshair' : 'default';
}

/** Warns up front if Supabase env vars are missing, so joining doesn't just silently fail. */
const memoryNet = Boolean((window as unknown as { __ORBIT_MEMORY_NET?: boolean }).__ORBIT_MEMORY_NET);

function updateMultiConfigNotice(): void {
  const joinBtn = $<HTMLButtonElement>('btn-join');
  if (isMultiplayerConfigured() || game.net.connected || memoryNet) {
    joinBtn.disabled = false;
    if (!game.net.connected) {
      els.netLine.textContent = 'Not connected.';
      delete els.netLine.dataset.status;
    }
    return;
  }
  joinBtn.disabled = true;
  els.netLine.dataset.status = 'error';
  els.netLine.textContent =
    'Multiplayer is offline: set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY, then redeploy.';
}

/** Where closing a sheet should return you to. */
function backgroundScreen(): Screen {
  return pendingResult ? 'result' : inGame ? 'game' : 'title';
}

function startGame(seedText?: string): void {
  sfx.unlock();
  music.unlock();
  if (settings.musicVolume > 0) music.start();
  const raw = (seedText ?? els.seedInput.value).trim();
  const seed = raw ? (/^\d+$/.test(raw) ? Number(raw) >>> 0 : hashString(raw)) : undefined;
  inGame = true;
  game.newCourse(seed);
  game.start();
  openScreen('game');
  toast('Drag from the ball and release to putt');
}

/** Idles a randomly generated system behind the menu so the title screen isn't dead space. */
function startAttractLoop(): void {
  game.newCourse();
  game.start();
  game.viewAll();
}

// ---------------------------------------------------------------- title menu

$('btn-play').addEventListener('click', () => {
  sfx.ui();
  startGame();
});

$('btn-play-multi').addEventListener('click', () => {
  sfx.ui();
  if (!inGame) {
    inGame = true;
    game.newCourse();
    game.start();
  }
  openScreen('multi');
});

$('btn-title-settings').addEventListener('click', () => {
  sfx.ui();
  openScreen('settings');
});

$('btn-reroll').addEventListener('click', () => {
  sfx.ui();
  els.seedInput.value = String((Math.random() * 0xffffffff) >>> 0);
});

// -------------------------------------------------------------- HUD buttons

$('btn-zoom-in').addEventListener('click', () => game.zoomBy(1.3));
$('btn-zoom-out').addEventListener('click', () => game.zoomBy(1 / 1.3));
$('btn-view-all').addEventListener('click', () => game.viewAll());
$('btn-recenter').addEventListener('click', () => game.recenter());
$('btn-settings').addEventListener('click', () => {
  sfx.ui();
  openScreen('settings');
});
$('btn-multi').addEventListener('click', () => {
  sfx.ui();
  openScreen('multi');
});

// ------------------------------------------------------------- result card

let pendingResult: HoleResult | null = null;

game.onHoleComplete = (r) => {
  pendingResult = r;
  if (r.outcome === 'sunk' || r.outcome === 'skipped') {
    const reward = awardFor({ strokes: r.strokes, par: r.par, outcome: r.outcome === 'sunk' ? 'sunk' : 'lost' });
    grant(cosmetics, reward);
    saveCosmetics(cosmetics);
    showStardustToast(reward);
  }
  // Let the sink animation and particles breathe before the card lands.
  setTimeout(() => {
    if (!pendingResult) return;
    $('result-label').textContent = r.label;
    $('result-title').textContent = `Hole ${r.hole} ${r.outcome === 'sunk' ? 'complete' : 'conceded'}`;
    $('result-strokes').textContent = String(r.strokes);
    $('result-par').textContent = String(r.par);
    $('result-total').textContent = String(r.total);
    const nextTier = tierFor(r.hole + 1);
    $('result-next').textContent =
      game.net.connected
        ? "Press Ready when you're done."
        : `Up next: hole ${r.hole + 1} · ${nextTier}`;
    $<HTMLButtonElement>('btn-next').textContent = game.net.connected ? 'Ready' : 'Next hole';
    // The hole is already scored with the lobby — replaying it would rewrite that score.
    show($('btn-retry'), !game.net.connected);
    openScreen('result');
  }, r.outcome === 'sunk' ? 900 : 200);
};

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

function renderWait(): void {
  const players = game.players;
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
  els.btnAdvance.disabled = !allReady;
  els.waitMsg.textContent = host
    ? allReady
      ? 'Everyone is ready.'
      : 'Waiting for all players to be ready…'
    : 'Waiting for the host to start the next hole.';
}

$('btn-advance').addEventListener('click', () => {
  sfx.ui();
  game.advanceRoomHole();
});

$('btn-retry').addEventListener('click', () => {
  sfx.ui();
  pendingResult = null;
  game.restartHole();
  openScreen('game');
});

// ------------------------------------------------------------------ settings

function bindToggle(id: string, key: keyof Settings): void {
  const el = $<HTMLInputElement>(id);
  el.checked = Boolean(settings[key]);
  el.addEventListener('change', () => {
    (settings[key] as boolean) = el.checked;
    commitSettings();
  });
}

function bindRange(id: string, key: keyof Settings, format: (v: number) => string, readoutId?: string): void {
  const el = $<HTMLInputElement>(id);
  el.value = String(settings[key]);
  const readout = readoutId ? $(readoutId) : null;
  const sync = () => {
    if (readout) readout.textContent = format(Number(el.value));
  };
  sync();
  el.addEventListener('input', () => {
    (settings[key] as number) = Number(el.value);
    sync();
    if (key === 'hue') $('hue-swatch').style.background = `hsl(${settings.hue}, 90%, 62%)`;
    commitSettings();
  });
}

function commitSettings(): void {
  saveSettings(settings);
  game.applySettings(settings);
}

const nameInput = $<HTMLInputElement>('set-name');
nameInput.value = settings.playerName;
nameInput.addEventListener('change', () => {
  settings.playerName = nameInput.value.trim() || randomName();
  nameInput.value = settings.playerName;
  commitSettings();
});

bindToggle('set-sound', 'soundEnabled');
bindToggle('set-autocam', 'autoCamera');
bindToggle('set-orbits', 'showOrbits');
bindToggle('set-trail', 'showTrail');
bindToggle('set-shake', 'screenShake');
bindToggle('set-names', 'showGhostNames');
bindToggle('set-colorblind', 'colorblind');

bindRange('set-volume', 'volume', (v) => `${Math.round(v * 100)}%`, 'volume-readout');
$<HTMLInputElement>('set-music').value = String(settings.musicVolume);
$('music-readout').textContent = `${Math.round(settings.musicVolume * 100)}%`;
music.volume = settings.musicVolume;
$<HTMLInputElement>('set-music').addEventListener('input', (e) => {
  settings.musicVolume = Number((e.target as HTMLInputElement).value);
  $('music-readout').textContent = `${Math.round(settings.musicVolume * 100)}%`;
  music.setVolume(settings.musicVolume);
  saveSettings(settings);
});
bindRange('set-aim', 'aimAssist', (v) => (v === 0 ? 'off' : `${v.toFixed(1)}s`), 'aim-readout');
bindRange('set-gravity', 'gravityIntensity', (v) => `${Math.round(v * 100)}%`, 'gravity-readout');
bindRange('set-hue', 'hue', (v) => String(Math.round(v)));
$('hue-swatch').style.background = `hsl(${settings.hue}, 90%, 62%)`;

const qualitySelect = $<HTMLSelectElement>('set-quality');
qualitySelect.value = String(settings.quality);
qualitySelect.addEventListener('change', () => {
  settings.quality = Number(qualitySelect.value);
  commitSettings();
});

const closeSettings = () => {
  sfx.ui(false);
  openScreen(backgroundScreen());
};
$('btn-close-settings').addEventListener('click', closeSettings);
$('btn-close-settings-2').addEventListener('click', closeSettings);

$('btn-quit').addEventListener('click', () => {
  sfx.ui(false);
  game.net.disconnect();
  inGame = false;
  pendingResult = null;
  // Bank the run before leaving so a good streak counts toward the best-run record.
  game.bankRun();
  saveStats(game.stats);
  refreshProgress();
  openScreen('title');
  startAttractLoop();
});

// --------------------------------------------------------------- multiplayer

const ROOM_WORDS = ['NEBULA', 'PULSAR', 'QUASAR', 'COMET', 'ORBIT', 'VECTOR', 'ECLIPSE', 'APOGEE'];

els.roomInput.value = new URLSearchParams(location.search).get('room')?.toUpperCase() ?? '';

$('btn-random-room').addEventListener('click', () => {
  els.roomInput.value = `${ROOM_WORDS[Math.floor(Math.random() * ROOM_WORDS.length)]}${Math.floor(Math.random() * 90 + 10)}`;
});

$('btn-join').addEventListener('click', () => {
  sfx.unlock();
  music.unlock();
  if (settings.musicVolume > 0) music.start();
  const room = els.roomInput.value.trim().toUpperCase();
  if (!room) {
    toast('Enter a room code first');
    return;
  }
  if (!inGame) {
    inGame = true;
    game.newCourse();
    game.start();
  }
  els.netLine.textContent = 'Connecting…';
  els.netLine.dataset.status = 'connecting';
  // The course is derived from the room code, so no seed needs to be exchanged.
  game.net.connect(room, settings.playerName, settings.hue, cosmetics.equipped);
});

$('btn-leave').addEventListener('click', () => {
  sfx.ui(false);
  game.net.disconnect();
  els.netLine.textContent = 'Not connected.';
  delete els.netLine.dataset.status;
  els.lobbyList.innerHTML = '';
  show(els.lobbyPanel, false);
  renderScoreboard([]);
});

$('btn-close-multi').addEventListener('click', () => {
  sfx.ui(false);
  openScreen(inGame ? 'game' : 'title');
});

game.onNetStatus = (status: NetStatus, detail?: string) => {
  els.netDot.dataset.status = status;
  if (status === 'online') {
    els.netLine.textContent = `Connected to room ${game.net.room}. Share the code and this page's URL.`;
    els.netLine.dataset.status = 'online';
  } else if (status === 'error') {
    els.netLine.textContent = detail ?? 'Connection failed.';
    els.netLine.dataset.status = 'error';
    show(els.lobbyPanel, false);
    toast('Could not reach the game server');
  } else if (status === 'offline') {
    els.netLine.textContent = 'Not connected.';
    delete els.netLine.dataset.status;
    show(els.lobbyPanel, false);
  }
};

// ---- host controls: aim policy & restart toggle -----------------------------

els.segAim.querySelectorAll<HTMLButtonElement>('.seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!game.isHost) return;
    sfx.ui();
    game.setRoomConfig({ aimPolicy: btn.dataset.val as AimPolicy });
  });
});

els.cfgRestart.addEventListener('change', () => {
  if (!game.isHost) return;
  sfx.ui();
  game.setRoomConfig({ allowRestart: els.cfgRestart.checked });
});

// ---- the shared lobby renderer, driven by every room-state update -----------

function renderLobby(): void {
  const connected = game.net.connected;
  show(els.lobbyPanel, connected);
  if (!connected) return;

  const host = game.isHost;
  els.lobbyPhase.textContent = game.phase === 'lobby' ? '· waiting to start' : '· in progress';

  // Player list with host crown, ready/kick affordances.
  els.lobbyList.innerHTML = '';
  for (const p of game.players) {
    const li = document.createElement('li');
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.background = `hsl(${p.hue}, 95%, 68%)`;

    const name = document.createElement('span');
    name.className = `lobby-name${p.id === game.net.selfId ? ' you' : ''}`;
    name.textContent = `${p.name}${p.id === game.net.selfId ? ' (you)' : ''}`;

    li.append(chip, name);

    if (p.id === game.hostId) {
      const tag = document.createElement('span');
      tag.className = 'tag host';
      tag.textContent = '★ Host';
      li.append(tag);
    } else if (game.phase === 'playing' && p.done) {
      const tag = document.createElement('span');
      tag.className = 'tag done';
      tag.textContent = '✓ Done';
      li.append(tag);
    }

    // Host can remove anyone but themselves.
    if (host && p.id !== game.net.selfId) {
      const kick = document.createElement('button');
      kick.className = 'kick';
      kick.title = `Kick ${p.name}`;
      kick.textContent = '⨯';
      kick.addEventListener('click', () => {
        if (confirm(`Remove ${p.name} from the room?`)) game.kickPlayer(p.id);
      });
      li.append(kick);
    }
    els.lobbyList.append(li);
  }

  // Host controls vs. read-only guest note.
  show(els.hostControls, host);
  show(els.guestNote, !host);

  els.segAim.querySelectorAll<HTMLButtonElement>('.seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.val === game.roomConfig.aimPolicy);
    b.disabled = !host;
  });
  els.cfgRestart.checked = game.roomConfig.allowRestart;
  els.cfgRestart.disabled = !host;

  if (!host) {
    const aim =
      game.roomConfig.aimPolicy === 'off'
        ? 'disabled for everyone'
        : game.roomConfig.aimPolicy === 'on'
          ? 'on for everyone'
          : 'each player’s choice';
    els.guestNote.textContent = `Host rules — aim guide: ${aim}; hole restarts: ${game.roomConfig.allowRestart ? 'allowed' : 'off'}.`;
  }

  // Call to action.
  els.lobbyCta.innerHTML = '';
  if (game.phase === 'lobby') {
    if (host) {
      const start = document.createElement('button');
      start.className = 'btn btn-primary';
      start.textContent = `Start game · ${game.players.length} player${game.players.length === 1 ? '' : 's'}`;
      start.addEventListener('click', () => {
        sfx.ui();
        game.startMultiplayerGame();
      });
      els.lobbyCta.append(start);
    } else {
      const wait = document.createElement('div');
      wait.className = 'waiting';
      wait.textContent = 'Waiting for the host to start the game…';
      els.lobbyCta.append(wait);
    }
  } else if (host) {
    const toLobby = document.createElement('button');
    toLobby.className = 'btn btn-ghost';
    toLobby.textContent = 'Return everyone to lobby';
    toLobby.addEventListener('click', () => {
      sfx.ui(false);
      game.returnRoomToLobby();
    });
    els.lobbyCta.append(toLobby);
  }
}

// Switch screens when the room starts or returns to the lobby.
game.onPhaseChange = (phase: RoomPhase) => {
  if (phase === 'playing') {
    pendingResult = null;
    openScreen('game');
    toast('Game started — good luck!');
  } else {
    openScreen('multi');
  }
};

game.onRoomState = renderLobby;

// Kicked from a room: bounce back to the title with an explanation.
game.onKicked = (reason: string) => {
  inGame = false;
  pendingResult = null;
  els.netLine.textContent = 'Not connected.';
  delete els.netLine.dataset.status;
  show(els.lobbyPanel, false);
  renderScoreboard([]);
  refreshProgress();
  openScreen('title');
  startAttractLoop();
  toast(reason);
};

function renderScoreboard(players: PlayerInfo[]): void {
  const connected = game.net.connected && players.length > 0;
  show(els.scoreboard, connected);
  els.roomLabel.textContent = connected ? game.net.room : 'Solo';
  if (!connected) return;

  const sorted = [...players].sort((a, b) => a.total + a.strokes - (b.total + b.strokes));
  els.scoreList.innerHTML = '';
  for (const p of sorted) {
    const li = document.createElement('li');
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.background = `hsl(${p.hue}, 95%, 68%)`;
    const name = document.createElement('span');
    name.className = `name${p.id === game.net.selfId ? ' you' : ''}`;
    name.textContent = p.name;
    const num = document.createElement('span');
    num.className = `num${p.done ? ' done' : ''}`;
    num.textContent = p.done ? `✓ ${p.strokes}` : String(p.strokes);
    li.append(chip, name, num);
    els.scoreList.append(li);
  }
}

game.onPlayersChanged = (players) => {
  renderScoreboard(players);
  if (!els.wait.classList.contains('hidden')) renderWait();

  const h = game.hud();
  const showReady = game.net.connected && h.phase === 'playing' && !h.waiting && players.length > 1;
  show(els.hudReady, showReady);
  if (showReady) els.hudReady.textContent = `${h.ready}/${players.length} ready`;

  // Remember everyone but yourself as a recent player. The lobby list itself is
  // rendered by renderLobby (game.onRoomState), which has the host/kick context.
  const others = players.filter((p) => p.id !== game.net.selfId);
  if (game.net.room && others.length > 0) {
    friends = rememberPlayers(friends, others, game.net.room, friendsSeenThisSession);
    saveFriends(friends);
    renderFriends();
  }
};

game.onAdvance = () => {
  pendingResult = null;
  openScreen('game');
};

// -------------------------------------------------------------- career stats

function tile(value: string, label: string, accent?: 'accent' | 'blue' | 'warn'): HTMLElement {
  const el = document.createElement('div');
  el.className = 'stat-tile';
  if (accent) el.dataset.accent = accent;
  const v = document.createElement('span');
  v.className = 'stat-value';
  v.textContent = value;
  const l = document.createElement('span');
  l.className = 'stat-label';
  l.textContent = label;
  el.append(v, l);
  return el;
}

function scoreRow(name: string, count: number, max: number, color: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'score-row';
  const n = document.createElement('span');
  n.className = 'score-name';
  n.textContent = name;
  const bar = document.createElement('span');
  bar.className = 'score-bar';
  const fill = document.createElement('span');
  fill.className = 'score-fill';
  fill.style.width = `${max > 0 ? (count / max) * 100 : 0}%`;
  fill.style.background = color;
  bar.append(fill);
  const num = document.createElement('span');
  num.className = 'score-num';
  num.textContent = String(count);
  row.append(n, bar, num);
  return row;
}

function renderStats(): void {
  const s = game.stats;
  const avg = averageStrokes(s);
  const relPar = s.bestRun ? s.bestRun.relPar : 0;

  els.statGrid.innerHTML = '';
  els.statGrid.append(
    tile(String(s.furthestHole), 'Furthest hole', 'blue'),
    tile(String(s.holesCompleted), 'Holes sunk', 'accent'),
    tile(String(s.aces), 'Holes in one', 'accent'),
    tile(String(underPar(s)), 'Under par'),
    tile(avg > 0 ? avg.toFixed(2) : '—', 'Avg strokes'),
    tile(String(s.bestStreak), 'Best streak', 'warn'),
    tile(
      s.bestRun ? `${relPar > 0 ? '+' : ''}${relPar}` : '—',
      s.bestRun ? `Best run · ${s.bestRun.holes} holes` : 'Best run',
      s.bestRun && relPar <= 0 ? 'accent' : undefined,
    ),
    tile(String(s.shots), 'Shots taken'),
    tile(formatDistance(s.totalDistance), 'Units travelled'),
    tile(formatDistance(s.longestShot), 'Longest shot'),
    tile(String(s.bounces), 'Bounces'),
    tile(String(s.ballsLost + s.ballsCrushed + s.timesAdrift), 'Balls lost', 'warn'),
    tile(String(s.ballsCrushed), 'Black holes'),
    tile(String(s.multiplayerHoles), 'With friends'),
    tile(formatDuration(s.playTime), 'Time played'),
    tile(String(s.coursesStarted), 'Courses'),
  );

  const rows: [string, number, string][] = [
    ['Hole in one', s.aces, '#4dffb0'],
    ['Albatross', s.albatrosses, '#5fe0c0'],
    ['Eagle', s.eagles, '#67d3ff'],
    ['Birdie', s.birdies, '#7aa8ff'],
    ['Par', s.pars, '#9aa7c8'],
    ['Bogey', s.bogeys, '#ffb066'],
    ['Double+', s.worse, '#ff6b8b'],
    ['Conceded', s.holesConceded, '#7b6a86'],
  ];
  const max = Math.max(1, ...rows.map((r) => r[1]));
  els.scorecard.innerHTML = '';
  for (const [name, count, color] of rows) els.scorecard.append(scoreRow(name, count, max, color));

  const unlockedCount = ACHIEVEMENTS.filter((a) => s.achievements[a.id]).length;
  els.achCount.textContent = `${unlockedCount} / ${ACHIEVEMENTS.length}`;
  els.achGrid.innerHTML = '';
  for (const a of ACHIEVEMENTS) {
    const unlocked = Boolean(s.achievements[a.id]);
    const el = document.createElement('div');
    el.className = `ach ${unlocked ? 'unlocked' : 'locked'}`;

    const icon = document.createElement('span');
    icon.className = 'ach-icon';
    icon.textContent = a.icon;

    const body = document.createElement('div');
    body.className = 'ach-body';
    const name = document.createElement('div');
    name.className = 'ach-name';
    name.textContent = a.name;
    const desc = document.createElement('div');
    desc.className = 'ach-desc';
    desc.textContent = a.description;
    body.append(name, desc);

    if (!unlocked) {
      const done = Math.min(a.progress(s), a.goal);
      if (done > 0) {
        const bar = document.createElement('div');
        bar.className = 'ach-progress';
        const fill = document.createElement('span');
        fill.style.width = `${(done / a.goal) * 100}%`;
        bar.append(fill);
        body.append(bar);
      }
    }

    el.append(icon, body);
    el.title = unlocked
      ? `Unlocked ${new Date(s.achievements[a.id]).toLocaleDateString()}`
      : `${Math.floor(Math.min(a.progress(s), a.goal))} / ${a.goal}`;
    els.achGrid.append(el);
  }
}

const openStats = () => {
  sfx.ui();
  openScreen('stats');
};
$('btn-stats').addEventListener('click', openStats);
$('btn-title-stats').addEventListener('click', openStats);

const closeStats = () => {
  sfx.ui(false);
  openScreen(backgroundScreen());
};
$('btn-close-stats').addEventListener('click', closeStats);
$('btn-close-stats-2').addEventListener('click', closeStats);

function renderShop(): void {
  els.shopBalance.textContent = `✦ ${cosmetics.balance}`;
  els.shopList.innerHTML = '';
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
        applyEquippedSkin();
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
    els.shopList.appendChild(row);
  }
}

const openShop = () => {
  sfx.ui();
  openScreen('shop');
};
$('btn-shop').addEventListener('click', openShop);
$('btn-title-shop').addEventListener('click', openShop);

const closeShop = () => {
  sfx.ui(false);
  openScreen(backgroundScreen());
};
$('btn-close-shop').addEventListener('click', closeShop);
$('btn-close-shop-2').addEventListener('click', closeShop);

$('btn-reset-stats').addEventListener('click', () => {
  if (!confirm('Reset all career stats and achievements? This cannot be undone.')) return;
  game.stats = resetStats();
  renderStats();
  refreshProgress();
  toast('Career reset');
});

/** Stardust reward toast — mirrors the achievement-unlock toast DOM/class pattern exactly. */
function showStardustToast(amount: number): void {
  const el = document.createElement('div');
  el.className = 'ach-toast stardust';
  const icon = document.createElement('span');
  icon.className = 'ach-icon';
  icon.textContent = '✦';
  const body = document.createElement('div');
  const kicker = document.createElement('div');
  kicker.className = 'ach-kicker';
  kicker.textContent = 'Stardust earned';
  const name = document.createElement('div');
  name.className = 'ach-name';
  name.textContent = `+${amount}`;
  body.append(kicker, name);
  el.append(icon, body);
  els.achToasts.append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 400);
  }, 2600);
}

// Achievement unlock toasts, shown one at a time so they don't stack into a wall.
game.onAchievements = (unlocked: Achievement[]) => {
  unlocked.forEach((a, i) => {
    setTimeout(() => {
      sfx.levelUp();
      const el = document.createElement('div');
      el.className = 'ach-toast';
      const icon = document.createElement('span');
      icon.className = 'ach-icon';
      icon.textContent = a.icon;
      const body = document.createElement('div');
      const kicker = document.createElement('div');
      kicker.className = 'ach-kicker';
      kicker.textContent = 'Achievement unlocked';
      const name = document.createElement('div');
      name.className = 'ach-name';
      name.textContent = a.name;
      body.append(kicker, name);
      el.append(icon, body);
      els.achToasts.append(el);
      setTimeout(() => {
        el.classList.add('out');
        setTimeout(() => el.remove(), 400);
      }, 4200);
    }, i * 700);
  });
};

// ------------------------------------------------------------- recent players

let friends: KnownPlayer[] = loadFriends();
/** Names already counted this session, so the meeting tally doesn't inflate. */
const friendsSeenThisSession = new Set<string>();

function renderFriends(): void {
  els.friendList.innerHTML = '';
  if (friends.length === 0) {
    const note = document.createElement('li');
    note.className = 'empty-note';
    note.textContent = 'Nobody yet — join a room with a friend and they will show up here.';
    note.style.background = 'transparent';
    els.friendList.append(note);
    return;
  }

  for (const f of friends) {
    const li = document.createElement('li');
    if (f.starred) li.classList.add('starred');

    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.background = `hsl(${f.hue}, 95%, 68%)`;

    const main = document.createElement('div');
    main.className = 'friend-main';
    const name = document.createElement('span');
    name.className = 'friend-name';
    name.textContent = f.name;
    const meta = document.createElement('span');
    meta.className = 'friend-meta';
    meta.textContent = `${f.meetings} session${f.meetings === 1 ? '' : 's'} · ${f.lastRoom} · ${relativeTime(f.lastSeen)}`;
    main.append(name, meta);

    const star = document.createElement('button');
    star.className = `friend-btn star${f.starred ? ' on' : ''}`;
    star.textContent = f.starred ? '★' : '☆';
    star.title = f.starred ? 'Unpin' : 'Pin as friend';
    star.addEventListener('click', () => {
      friends = toggleStar(friends, f.key);
      saveFriends(friends);
      renderFriends();
      sfx.ui();
    });

    const join = document.createElement('button');
    join.className = 'friend-btn friend-join';
    join.textContent = 'Join';
    join.title = `Rejoin ${f.lastRoom}`;
    join.addEventListener('click', () => {
      els.roomInput.value = f.lastRoom;
      $('btn-join').click();
    });

    const forget = document.createElement('button');
    forget.className = 'friend-btn';
    forget.textContent = '✕';
    forget.title = 'Forget';
    forget.addEventListener('click', () => {
      friends = forgetPlayer(friends, f.key);
      saveFriends(friends);
      renderFriends();
      sfx.ui(false);
    });

    li.append(chip, main, join, star, forget);
    els.friendList.append(li);
  }
}

// -------------------------------------------------------------------- input

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  switch (e.key.toLowerCase()) {
    case 'escape':
      if (!els.settings.classList.contains('hidden')) closeSettings();
      else if (!els.stats.classList.contains('hidden')) closeStats();
      else if (!els.multi.classList.contains('hidden')) openScreen(backgroundScreen());
      else if (inGame) openScreen('settings');
      break;
    case 't':
      if (els.stats.classList.contains('hidden')) openStats();
      else closeStats();
      break;
    case 'f':
      if (inGame) game.viewAll();
      break;
    case 'c':
      if (inGame) game.recenter();
      break;
    case 'r':
      if (inGame && els.result.classList.contains('hidden')) {
        game.restartHole();
        toast(game.net.connected ? 'Hole restarted · +1 penalty stroke' : 'Hole restarted');
      }
      break;
    case 'm':
      if (inGame) openScreen('multi');
      break;
    case 'n':
      if (inGame && !els.result.classList.contains('hidden')) {
        pendingResult = null;
        game.nextHole();
        openScreen('game');
      }
      break;
    case 'x':
      if (inGame && els.result.classList.contains('hidden')) game.skipHole();
      break;
    case '+':
    case '=':
      if (inGame) game.zoomBy(1.25);
      break;
    case '-':
      if (inGame) game.zoomBy(1 / 1.25);
      break;
  }
});

// --------------------------------------------------------------- HUD ticker

function refreshProgress(): void {
  const s = game.stats;
  if (!s.holesPlayed) {
    els.progressLine.textContent = 'No holes played yet. Every course is generated from a seed.';
    return;
  }
  const bits = [
    `furthest hole ${s.furthestHole}`,
    `${s.holesCompleted} sunk`,
    s.aces > 0 ? `${s.aces} ace${s.aces === 1 ? '' : 's'}` : null,
    `${ACHIEVEMENTS.filter((a) => s.achievements[a.id]).length}/${ACHIEVEMENTS.length} achievements`,
  ].filter(Boolean);
  els.progressLine.textContent = bits.join(' · ');
}

function tickHud(): void {
  if (inGame) {
    const h = game.hud();
    els.hole.textContent = String(h.hole);
    els.par.textContent = String(h.par);
    els.strokes.textContent = String(h.strokes);
    els.total.textContent = String(h.total);
    els.tier.textContent = h.tier;
    els.tier.dataset.tier = h.tier;
    els.netDot.dataset.status = h.netStatus;
  }
  requestAnimationFrame(tickHud);
}

// Handle for the automated browser smoke test; harmless in normal play.
(window as unknown as { __game: Game }).__game = game;

refreshProgress();
renderFriends();
openScreen('title');
tickHud();
startAttractLoop();

// Bank play time and the current run if the tab is closed mid-game.
window.addEventListener('pagehide', () => {
  game.bankRun();
  saveStats(game.stats);
});

// Deep link: ?room=CODE opens straight into the multiplayer sheet.
if (new URLSearchParams(location.search).get('room')) {
  inGame = true;
  openScreen('multi');
}

// Test-only: when the in-memory relay is forced (browser smoke test), expose a way to
// spawn simulated peers in this same page so the real UI can be driven against them.
// Two Playwright tabs can't share the in-memory relay, so the "friend" lives in-page.
if (memoryNet) {
  const peers: Record<string, { c: RealtimeClient; state: () => unknown; kicked: () => boolean }> = {};
  (window as unknown as { __orbitPeer: unknown }).__orbitPeer = {
    spawn(name: string, room: string, hue = 120) {
      let last: import('./net/protocol').RoomState | null = null;
      let kicked = false;
      const c = new RealtimeClient({
        onWelcome: (m) => (last = m.state),
        onState: (s) => (last = s),
        onPos: () => {},
        onKicked: () => (kicked = true),
        onStatus: () => {},
      });
      c.connect(room, name, hue);
      peers[name] = { c, state: () => last, kicked: () => kicked };
    },
    isHost: (n: string) => peers[n]?.c.amHost ?? false,
    selfId: (n: string) => peers[n]?.c.selfId ?? '',
    phase: (n: string) => (peers[n]?.state() as { phase?: string } | null)?.phase,
    aimPolicy: (n: string) => (peers[n]?.state() as { config?: { aimPolicy?: string } } | null)?.config?.aimPolicy,
    players: (n: string) => (peers[n]?.state() as { players?: unknown[] } | null)?.players?.length ?? 0,
    kicked: (n: string) => peers[n]?.kicked() ?? false,
    start: (n: string) => peers[n]?.c.start(),
    setConfig: (n: string, cfg: unknown) => peers[n]?.c.setConfig(cfg as never),
    markDone: (n: string, s: number, r: 'sunk' | 'lost') => {
      peers[n]?.c.markScore(s, r);
      peers[n]?.c.markReady();
    },
    sendPos: (n: string, x: number, y: number, s: string) => peers[n]?.c.sendPos(x, y, s, performance.now() + Math.random() * 1e6),
    disconnect: (n: string) => peers[n]?.c.disconnect(),
  };
}
