/**
 * A deliberately account-free stand-in for a friend list.
 *
 * A real friend list needs identity: accounts, auth and a database. The room server is
 * in-memory by design, so instead we remember locally who you've shared a room with.
 * Starred entries pin to the top and act as your friends; the rest age out.
 */
export interface KnownPlayer {
  /** Lowercased name — the only stable handle we have without accounts. */
  key: string;
  name: string;
  hue: number;
  lastRoom: string;
  lastSeen: number;
  /** Number of distinct sessions you've been in a room together. */
  meetings: number;
  starred: boolean;
}

const KEY = 'orbit-golf.friends.v1';
const MAX = 40;

export function loadFriends(): KnownPlayer[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as KnownPlayer[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function saveFriends(list: KnownPlayer[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* private mode — the list just won't persist */
  }
}

/**
 * Folds the current lobby into the local roster. `sessionSeen` guards the meeting counter
 * so sitting in a room for an hour doesn't inflate it on every player-list broadcast.
 */
export function rememberPlayers(
  list: KnownPlayer[],
  players: { name: string; hue: number }[],
  room: string,
  sessionSeen: Set<string>,
): KnownPlayer[] {
  const now = Date.now();
  for (const p of players) {
    const key = p.name.trim().toLowerCase();
    if (!key) continue;
    let entry = list.find((e) => e.key === key);
    if (!entry) {
      entry = { key, name: p.name, hue: p.hue, lastRoom: room, lastSeen: now, meetings: 0, starred: false };
      list.push(entry);
    }
    entry.name = p.name;
    entry.hue = p.hue;
    entry.lastRoom = room;
    entry.lastSeen = now;
    if (!sessionSeen.has(key)) {
      sessionSeen.add(key);
      entry.meetings++;
    }
  }
  return sortFriends(list);
}

export function sortFriends(list: KnownPlayer[]): KnownPlayer[] {
  return list.sort((a, b) => {
    if (a.starred !== b.starred) return a.starred ? -1 : 1;
    return b.lastSeen - a.lastSeen;
  });
}

export function toggleStar(list: KnownPlayer[], key: string): KnownPlayer[] {
  const entry = list.find((e) => e.key === key);
  if (entry) entry.starred = !entry.starred;
  return sortFriends(list);
}

export function forgetPlayer(list: KnownPlayer[], key: string): KnownPlayer[] {
  return list.filter((e) => e.key !== key);
}

export function relativeTime(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 90) return 'just now';
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h ago`;
  const d = h / 24;
  if (d < 7) return `${Math.floor(d)}d ago`;
  return new Date(ts).toLocaleDateString();
}
