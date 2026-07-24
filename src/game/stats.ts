import type { BodyKind, DifficultyTier } from './types';

/**
 * Career stats, persisted in localStorage. Everything here is derived from play — there
 * is no server involved, so it survives across sessions on this device only.
 */
export interface Stats {
  version: number;
  firstPlayed: number;
  lastPlayed: number;

  coursesStarted: number;
  holesPlayed: number;
  holesCompleted: number;
  holesConceded: number;
  furthestHole: number;

  totalStrokes: number;
  aces: number;
  albatrosses: number;
  eagles: number;
  birdies: number;
  pars: number;
  bogeys: number;
  worse: number;

  currentStreak: number;
  bestStreak: number;

  shots: number;
  bounces: number;
  totalDistance: number;
  longestShot: number;

  ballsLost: number;
  ballsCrushed: number;
  timesAdrift: number;

  playTime: number;
  multiplayerHoles: number;

  /** Cup surface types you've sunk a ball on, for the "grand tour" achievement. */
  sunkOn: Partial<Record<BodyKind, number>>;
  tiersCleared: Partial<Record<DifficultyTier, number>>;

  bestRun: { holes: number; strokes: number; relPar: number } | null;
  achievements: Record<string, number>;
}

const KEY = 'orbit-golf.stats.v2';
const LEGACY_KEY = 'orbit-golf.progress.v1';

function empty(): Stats {
  return {
    version: 2,
    firstPlayed: Date.now(),
    lastPlayed: Date.now(),
    coursesStarted: 0,
    holesPlayed: 0,
    holesCompleted: 0,
    holesConceded: 0,
    furthestHole: 0,
    totalStrokes: 0,
    aces: 0,
    albatrosses: 0,
    eagles: 0,
    birdies: 0,
    pars: 0,
    bogeys: 0,
    worse: 0,
    currentStreak: 0,
    bestStreak: 0,
    shots: 0,
    bounces: 0,
    totalDistance: 0,
    longestShot: 0,
    ballsLost: 0,
    ballsCrushed: 0,
    timesAdrift: 0,
    playTime: 0,
    multiplayerHoles: 0,
    sunkOn: {},
    tiersCleared: {},
    bestRun: null,
    achievements: {},
  };
}

export function loadStats(): Stats {
  let stored: Partial<Stats> = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Stats>;
  } catch {
    stored = {};
  }
  const stats: Stats = { ...empty(), ...stored, sunkOn: { ...stored.sunkOn }, tiersCleared: { ...stored.tiersCleared }, achievements: { ...stored.achievements } };

  // Fold in the older, much thinner progress record so early players keep their history.
  if (!stored.version) {
    try {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? 'null') as
        | { furthestHole?: number; totalStrokes?: number; holesPlayed?: number }
        | null;
      if (legacy) {
        stats.furthestHole = Math.max(stats.furthestHole, legacy.furthestHole ?? 0);
        stats.totalStrokes += legacy.totalStrokes ?? 0;
        stats.holesPlayed += legacy.holesPlayed ?? 0;
      }
    } catch {
      /* nothing to migrate */
    }
  }
  return stats;
}

export function saveStats(s: Stats): void {
  try {
    s.lastPlayed = Date.now();
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode — stats just won't persist */
  }
}

export function resetStats(): Stats {
  const fresh = empty();
  saveStats(fresh);
  return fresh;
}

// ------------------------------------------------------------------ recording

export interface HoleRecord {
  hole: number;
  par: number;
  strokes: number;
  outcome: 'sunk' | 'skipped';
  tier: DifficultyTier;
  cupSurface: BodyKind;
  multiplayer: boolean;
}

export function recordShot(s: Stats, distance: number, bounces: number): void {
  s.shots++;
  s.bounces += bounces;
  s.totalDistance += distance;
  s.longestShot = Math.max(s.longestShot, distance);
}

export function recordPenalty(s: Stats, kind: 'lost' | 'crush' | 'adrift'): void {
  if (kind === 'lost') s.ballsLost++;
  else if (kind === 'crush') s.ballsCrushed++;
  else s.timesAdrift++;
}

export function recordHole(s: Stats, r: HoleRecord): void {
  s.holesPlayed++;
  s.totalStrokes += r.strokes;
  s.furthestHole = Math.max(s.furthestHole, r.hole);
  s.tiersCleared[r.tier] = (s.tiersCleared[r.tier] ?? 0) + 1;
  if (r.multiplayer) s.multiplayerHoles++;

  if (r.outcome === 'skipped') {
    s.holesConceded++;
    s.currentStreak = 0;
    return;
  }

  s.holesCompleted++;
  s.sunkOn[r.cupSurface] = (s.sunkOn[r.cupSurface] ?? 0) + 1;

  const rel = r.strokes - r.par;
  if (r.strokes === 1) s.aces++;
  if (rel <= -3) s.albatrosses++;
  else if (rel === -2) s.eagles++;
  else if (rel === -1) s.birdies++;
  else if (rel === 0) s.pars++;
  else if (rel === 1) s.bogeys++;
  else s.worse++;

  if (rel <= 0) {
    s.currentStreak++;
    s.bestStreak = Math.max(s.bestStreak, s.currentStreak);
  } else {
    s.currentStreak = 0;
  }
}

/** Called when a run ends (back to menu, or a new course) to bank the best result. */
export function recordRun(s: Stats, holes: number, strokes: number, relPar: number): void {
  if (holes < 3) return;
  if (!s.bestRun || relPar < s.bestRun.relPar || (relPar === s.bestRun.relPar && holes > s.bestRun.holes)) {
    s.bestRun = { holes, strokes, relPar };
  }
}

export const underPar = (s: Stats): number => s.albatrosses + s.eagles + s.birdies;

export function averageStrokes(s: Stats): number {
  return s.holesCompleted > 0 ? s.totalStrokes / s.holesCompleted : 0;
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${Math.floor(seconds % 60)}s`;
  return `${Math.floor(seconds)}s`;
}

export function formatDistance(units: number): string {
  if (units >= 1_000_000) return `${(units / 1_000_000).toFixed(2)}M`;
  if (units >= 1000) return `${(units / 1000).toFixed(1)}k`;
  return Math.round(units).toString();
}

// --------------------------------------------------------------- achievements

export interface Achievement {
  id: string;
  name: string;
  description: string;
  icon: string;
  /** Current progress toward the goal, for the progress bar. */
  progress: (s: Stats) => number;
  goal: number;
}

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'first-light', name: 'First Light', description: 'Sink your first hole.', icon: '🌱', progress: (s) => s.holesCompleted, goal: 1 },
  { id: 'ace', name: 'Hole in One', description: 'Sink a hole straight from the tee.', icon: '🎯', progress: (s) => s.aces, goal: 1 },
  { id: 'ace-3', name: 'Sharpshooter', description: 'Land three holes in one.', icon: '🏹', progress: (s) => s.aces, goal: 3 },
  { id: 'ace-10', name: 'Marksman', description: 'Land ten holes in one.', icon: '💫', progress: (s) => s.aces, goal: 10 },
  { id: 'under-10', name: 'Under Pressure', description: 'Finish 10 holes under par.', icon: '🐦', progress: underPar, goal: 10 },
  { id: 'streak-5', name: 'In The Zone', description: 'Five holes in a row at or under par.', icon: '🔥', progress: (s) => s.bestStreak, goal: 5 },
  { id: 'reach-10', name: 'Outer Belt', description: 'Reach hole 10.', icon: '🚀', progress: (s) => s.furthestHole, goal: 10 },
  { id: 'reach-20', name: 'Deep Field', description: 'Reach hole 20.', icon: '🌌', progress: (s) => s.furthestHole, goal: 20 },
  { id: 'reach-30', name: 'Event Horizon', description: 'Reach hole 30 and the Extreme tier.', icon: '⚫', progress: (s) => s.furthestHole, goal: 30 },
  { id: 'void', name: 'Spaghettified', description: 'Feed a ball to a black hole.', icon: '🕳️', progress: (s) => s.ballsCrushed, goal: 1 },
  { id: 'adrift', name: 'Lost Contact', description: 'Drift a full minute without touching anything.', icon: '📡', progress: (s) => s.timesAdrift, goal: 1 },
  { id: 'long-bomb', name: 'Long Bomb', description: 'Travel over 5,000 units in a single shot.', icon: '☄️', progress: (s) => s.longestShot, goal: 5000 },
  { id: 'odyssey', name: 'Odyssey', description: 'Travel 100,000 units in total.', icon: '🛰️', progress: (s) => s.totalDistance, goal: 100000 },
  { id: 'pinball', name: 'Pinball', description: 'Bounce off planet surfaces 500 times.', icon: '🎱', progress: (s) => s.bounces, goal: 500 },
  { id: 'grand-tour', name: 'Grand Tour', description: 'Sink a ball on rock, ice, lava and gas worlds.', icon: '🪐', progress: (s) => (['rock', 'ice', 'lava', 'gas'] as BodyKind[]).filter((k) => (s.sunkOn[k] ?? 0) > 0).length, goal: 4 },
  { id: 'marathon', name: 'Marathon', description: 'Play 100 holes.', icon: '🏆', progress: (s) => s.holesPlayed, goal: 100 },
  { id: 'not-alone', name: 'Not Alone', description: 'Play a hole in a room with a friend.', icon: '👥', progress: (s) => s.multiplayerHoles, goal: 1 },
];

/** Unlocks anything newly earned and returns just those, so the UI can announce them. */
export function checkAchievements(s: Stats): Achievement[] {
  const unlocked: Achievement[] = [];
  for (const a of ACHIEVEMENTS) {
    if (s.achievements[a.id]) continue;
    if (a.progress(s) >= a.goal) {
      s.achievements[a.id] = Date.now();
      unlocked.push(a);
    }
  }
  return unlocked;
}
