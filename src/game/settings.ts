export interface Settings {
  playerName: string;
  hue: number;
  volume: number;
  soundEnabled: boolean;
  /** Seconds of predicted flight drawn by the aim guide. 0 = off. */
  aimAssist: number;
  gravityIntensity: number;
  showOrbits: boolean;
  showGhostNames: boolean;
  showTrail: boolean;
  autoCamera: boolean;
  /** 0 = potato, 1 = balanced, 2 = pretty. */
  quality: number;
  screenShake: boolean;
}

const KEY = 'orbit-golf.settings.v1';

const DEFAULTS: Settings = {
  playerName: '',
  hue: Math.floor(Math.random() * 360),
  volume: 0.6,
  soundEnabled: true,
  aimAssist: 2.5,
  gravityIntensity: 1,
  showOrbits: true,
  showGhostNames: true,
  showTrail: true,
  autoCamera: true,
  quality: 2,
  screenShake: true,
};

const ADJECTIVES = ['Cosmic', 'Lunar', 'Solar', 'Astro', 'Nebula', 'Quantum', 'Orbital', 'Stellar'];
const NOUNS = ['Putter', 'Comet', 'Drifter', 'Ace', 'Pilot', 'Wedge', 'Rover', 'Eagle'];

export function randomName(): string {
  return `${ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]} ${NOUNS[Math.floor(Math.random() * NOUNS.length)]}`;
}

export function loadSettings(): Settings {
  let stored: Partial<Settings> = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
  } catch {
    stored = {};
  }
  const s = { ...DEFAULTS, ...stored };
  if (!s.playerName) s.playerName = randomName();
  return s;
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode — settings just won't persist */
  }
}

// Career progress lives in ./stats — the old `progress.v1` record is migrated there.
