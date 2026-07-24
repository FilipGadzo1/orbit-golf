/**
 * Headless integration test for the serverless (Supabase Realtime) multiplayer logic.
 *
 * It runs several real RealtimeClients against the in-memory relay transport in one
 * process — no network, no browser — and asserts the parts that used to be the server's
 * job: host election, the lobby→playing gate, room-config authority, kick, hole
 * advancement, and host reassignment.
 */
import { RealtimeClient, setAdvanceDelay } from '../src/net/realtime';
import { memoryTransportFactory, resetMemoryRelays } from '../src/net/transport';
import type { RoomState } from '../src/net/protocol';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) {
    failures++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A test harness around one client that records the latest room state it saw. */
class Peer {
  client: RealtimeClient;
  state: RoomState | null = null;
  seed = 0;
  kicked = false;
  lastCountdown = 0;
  ghostMoves = 0;

  constructor(readonly label: string) {
    this.client = new RealtimeClient(
      {
        onWelcome: (m) => {
          this.seed = m.seed;
          this.state = m.state;
        },
        onState: (s) => {
          this.state = s;
        },
        onPos: () => {
          this.ghostMoves++;
        },
        onCountdown: (s) => {
          this.lastCountdown = s;
        },
        onKicked: () => {
          this.kicked = true;
        },
        onStatus: () => {},
      },
      memoryTransportFactory,
    );
  }

  join(room: string): void {
    this.client.connect(room, this.label, 200);
  }

  get isHost(): boolean {
    return this.client.amHost;
  }
  get players() {
    return this.state?.players ?? [];
  }
  get phase() {
    return this.state?.phase;
  }
  get hole() {
    return this.state?.hole;
  }
  get hostId() {
    return this.state?.host;
  }
}

async function main(): Promise<void> {
  console.log('Orbit Golf — multiplayer (Supabase Realtime logic) checks\n');
  setAdvanceDelay(40);

  // ---- host election & lobby ------------------------------------------------
  resetMemoryRelays();
  const a = new Peer('Ada');
  const b = new Peer('Grace');
  const c = new Peer('Lin');

  a.join('NEBULA');
  await sleep(6); // stagger joins so joinedAt is strictly ordered
  b.join('NEBULA');
  await sleep(6);
  c.join('NEBULA');
  await sleep(20);

  check('all three peers connected', a.client.connected && b.client.connected && c.client.connected);
  check('seed is derived identically from the room code', a.seed === b.seed && b.seed === c.seed && a.seed !== 0, `${a.seed}/${b.seed}/${c.seed}`);
  check('everyone sees three players', a.players.length === 3 && c.players.length === 3, `${a.players.length}/${c.players.length}`);

  check('first joiner is the host', a.isHost, `hostId=${a.hostId}`);
  check('later joiners are not host', !b.isHost && !c.isHost);
  check('all peers agree on the same host', a.hostId === b.hostId && b.hostId === c.hostId, `${a.hostId}/${b.hostId}/${c.hostId}`);
  check('room starts in the lobby', a.phase === 'lobby' && b.phase === 'lobby', `${a.phase}/${b.phase}`);

  // ---- config authority -----------------------------------------------------
  a.client.setConfig({ aimPolicy: 'off' });
  await sleep(20);
  check('host config change reaches every peer', b.state?.config.aimPolicy === 'off' && c.state?.config.aimPolicy === 'off', `${b.state?.config.aimPolicy}/${c.state?.config.aimPolicy}`);

  // A non-host attempting the same is ignored (client guards + host is authority).
  b.client.setConfig({ aimPolicy: 'free' });
  await sleep(20);
  check('a non-host cannot change room config', a.state?.config.aimPolicy === 'off' && c.state?.config.aimPolicy === 'off', `${a.state?.config.aimPolicy}/${c.state?.config.aimPolicy}`);

  a.client.setConfig({ allowRestart: false });
  await sleep(20);
  check('allowRestart propagates', b.state?.config.allowRestart === false, `${b.state?.config.allowRestart}`);

  // ---- start gate -----------------------------------------------------------
  b.client.start(); // non-host: should do nothing
  await sleep(20);
  check('a non-host cannot start the game', a.phase === 'lobby', `${a.phase}`);

  a.client.start();
  await sleep(20);
  check('host start moves everyone to playing', a.phase === 'playing' && b.phase === 'playing' && c.phase === 'playing', `${a.phase}/${b.phase}/${c.phase}`);
  check('game starts on hole 1', a.hole === 1 && c.hole === 1, `${a.hole}/${c.hole}`);

  // ---- positions (ghosts) ---------------------------------------------------
  const beforeGhost = a.ghostMoves;
  let t = 100000;
  for (let i = 0; i < 5; i++) b.client.sendPos(100 + i, 200, 'flying', (t += 60));
  await sleep(10);
  check('flying positions stream to other peers as ghosts', a.ghostMoves - beforeGhost >= 3, `moves=${a.ghostMoves - beforeGhost}`);
  check('a peer does not receive its own position', b.ghostMoves === 0, `self moves=${b.ghostMoves}`);

  // A finished player must go quiet — repeated idle sends must NOT keep streaming, or they
  // would starve Presence and hang advancement (the bug this guards).
  const beforeIdle = a.ghostMoves;
  for (let i = 0; i < 20; i++) b.client.sendPos(500, 500, 'idle', (t += 60));
  await sleep(10);
  check('a resting player stops flooding the channel', a.ghostMoves - beforeIdle <= 1, `idle sends delivered=${a.ghostMoves - beforeIdle}`);

  // ---- hole advancement -----------------------------------------------------
  // Every player keeps "spamming" idle positions after finishing; advancement must still
  // happen (broadcast-based readiness, not starved by position traffic).
  a.client.markDone(3, 'sunk');
  b.client.markDone(4, 'sunk');
  for (let i = 0; i < 10; i++) {
    a.client.sendPos(1, 1, 'sunk', (t += 60));
    b.client.sendPos(2, 2, 'sunk', (t += 60));
  }
  await sleep(20);
  check('room does not advance until everyone is done', a.hole === 1, `hole=${a.hole}`);
  c.client.markDone(2, 'sunk');
  await sleep(120); // > advance delay
  check('room advances once every player is done', a.hole === 2 && b.hole === 2 && c.hole === 2, `${a.hole}/${b.hole}/${c.hole}`);
  check('scores carry into the running total after a hole', (a.players.find((p) => p.name === 'Ada')?.total ?? -1) === 3, `total=${a.players.find((p) => p.name === 'Ada')?.total}`);
  check('the done flags reset for the new hole', a.players.every((p) => !p.done), JSON.stringify(a.players.map((p) => p.done)));

  // Advance again with the HOST finishing last — the ordering most prone to a self-stall.
  b.client.markDone(3, 'sunk');
  c.client.markReady();
  await sleep(30);
  check('room waits while the host is still playing', a.hole === 2, `hole=${a.hole}`);
  a.client.markDone(2, 'sunk'); // host finishes last
  await sleep(120);
  check('room advances when the host finishes last', a.hole === 3 && b.hole === 3 && c.hole === 3, `${a.hole}/${b.hole}/${c.hole}`);

  // ---- kick -----------------------------------------------------------------
  const graceId = a.players.find((p) => p.name === 'Grace')?.id ?? '';
  a.client.kick(graceId);
  await sleep(20);
  check('the kicked player is notified', b.kicked, `kicked=${b.kicked}`);
  check('the kicked player is disconnected', !b.client.connected);
  check('remaining peers drop the kicked player', a.players.length === 2 && c.players.length === 2, `${a.players.length}/${c.players.length}`);

  // A non-host cannot kick.
  const linId = a.players.find((p) => p.name === 'Lin')?.id ?? '';
  c.client.kick(a.players.find((p) => p.name === 'Ada')?.id ?? '');
  await sleep(20);
  check('a non-host cannot kick the host', a.client.connected && a.players.length === 2, `players=${a.players.length}`);

  // ---- host reassignment ----------------------------------------------------
  const oldHost = a.hostId;
  a.client.disconnect();
  await sleep(20);
  check('host role transfers when the host leaves', c.isHost && c.hostId !== oldHost, `newHost=${c.hostId} old=${oldHost}`);
  check('the new host can drive the room', (() => { c.client.setConfig({ aimPolicy: 'on' }); return true; })());
  await sleep(20);
  check('the new host’s config takes effect', c.state?.config.aimPolicy === 'on', `${c.state?.config.aimPolicy}`);
  void linId;

  c.client.disconnect();

  // ---- determinism: same room code → same seed, different code → different --
  resetMemoryRelays();
  const x = new Peer('X');
  const y = new Peer('Y');
  x.join('APOGEE');
  y.join('DIFFERENT');
  await sleep(20);
  check('different room codes yield different seeds', x.seed !== y.seed, `${x.seed} vs ${y.seed}`);
  x.client.disconnect();
  y.client.disconnect();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  } else {
    console.log('All multiplayer checks passed.');
  }
}

void main();
