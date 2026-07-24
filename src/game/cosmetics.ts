/**
 * Cosmetics + local currency ("Stardust"). An independent localStorage module, same
 * shape as stats.ts / settings.ts / friends.ts — its own key and load/save. Currency is
 * device-local (no server), so there is nothing to cheat but your own wallet.
 */
export interface Skin {
  id: string;
  name: string;
  /** Stardust price. The default skin is 0 and owned from the start. */
  price: number;
  /** Ball body radial-gradient stops: [inner, outer]. */
  body: [string, string];
  /** Outer glow colour (rgba string). */
  glow: string;
  /** Accent used for the ghost ring so others can tell your skin apart. */
  accent: string;
}

/** First entry is the free default and reproduces the original ball look exactly. */
export const SKINS: Skin[] = [
  { id: 'classic', name: 'Classic', price: 0, body: ['#ffffff', '#9fc4e8'], glow: 'rgba(190, 235, 255, 0.5)', accent: 'hsla(205, 100%, 82%, 0.95)' },
  { id: 'ember', name: 'Ember', price: 150, body: ['#fff2d6', '#e8863f'], glow: 'rgba(255, 190, 120, 0.5)', accent: 'hsla(28, 100%, 70%, 0.95)' },
  { id: 'aurora', name: 'Aurora', price: 350, body: ['#eafff4', '#39e0a5'], glow: 'rgba(120, 255, 200, 0.5)', accent: 'hsla(160, 90%, 70%, 0.95)' },
  { id: 'nova', name: 'Nova', price: 700, body: ['#fbe9ff', '#b45cff'], glow: 'rgba(210, 150, 255, 0.5)', accent: 'hsla(280, 100%, 78%, 0.95)' },
  { id: 'gold', name: 'Champion Gold', price: 1500, body: ['#fff7e0', '#f2c14e'], glow: 'rgba(255, 220, 130, 0.55)', accent: 'hsla(45, 100%, 68%, 0.98)' },
];

export interface Cosmetics {
  version: number;
  balance: number;
  owned: string[];
  equipped: string;
}

const KEY = 'orbit-golf.cosmetics.v1';
const DEFAULT_ID = 'classic';

function empty(): Cosmetics {
  return { version: 1, balance: 0, owned: [DEFAULT_ID], equipped: DEFAULT_ID };
}

export function loadCosmetics(): Cosmetics {
  let stored: Partial<Cosmetics> = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Cosmetics>;
  } catch {
    stored = {};
  }
  const c = { ...empty(), ...stored };
  // Repair invariants: classic always owned, equipped must be owned & real.
  if (!c.owned.includes(DEFAULT_ID)) c.owned = [DEFAULT_ID, ...c.owned];
  c.owned = c.owned.filter((id) => SKINS.some((s) => s.id === id));
  if (!c.owned.includes(c.equipped)) c.equipped = DEFAULT_ID;
  return c;
}

export function saveCosmetics(c: Cosmetics): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* private mode — cosmetics just won't persist */
  }
}

export function resetCosmetics(): Cosmetics {
  const fresh = empty();
  saveCosmetics(fresh);
  return fresh;
}

export function skinById(id: string): Skin {
  return SKINS.find((s) => s.id === id) ?? SKINS[0];
}

/** Stardust awarded for a completed hole. Pure and generous; no anti-farm needed. */
export function awardFor(r: { strokes: number; par: number; outcome: 'sunk' | 'lost' }): number {
  if (r.outcome !== 'sunk') return 2;
  const base = 10;
  const rel = r.strokes - r.par;
  const bonus = rel <= -3 ? 50 : rel === -2 ? 30 : rel === -1 ? 20 : rel === 0 ? 10 : rel === 1 ? 5 : 0;
  const ace = r.strokes === 1 ? 25 : 0;
  return base + bonus + ace;
}

export function grant(c: Cosmetics, amount: number): void {
  c.balance = Math.max(0, c.balance + Math.round(amount));
}

export function buy(c: Cosmetics, id: string): boolean {
  const skin = SKINS.find((s) => s.id === id);
  if (!skin || c.owned.includes(id) || c.balance < skin.price) return false;
  c.balance -= skin.price;
  c.owned.push(id);
  return true;
}

export function equip(c: Cosmetics, id: string): boolean {
  if (!c.owned.includes(id)) return false;
  c.equipped = id;
  return true;
}
