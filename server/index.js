import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');
const PORT = Number(process.env.PORT ?? 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Serves the production build when it exists; in dev Vite handles the client. */
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  // Lightweight health check for platform probes (Render etc.).
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  let filePath = path.join(DIST, decodeURIComponent(url.pathname));
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST, 'index.html');
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Orbit Golf server is running. Run `npm run build` to serve the client from here,\nor use `npm run dev` and open http://localhost:5173');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

const wss = new WebSocketServer({ server, path: '/ws' });

const DEFAULT_CONFIG = { aimPolicy: 'free', allowRestart: true };

/** room code -> room record */
const rooms = new Map();
let nextId = 1;

function publicPlayers(room) {
  return [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    hue: p.hue,
    strokes: p.strokes,
    total: p.total,
    state: p.state,
    done: p.done,
  }));
}

/** The single source of truth clients render from. */
function roomState(room) {
  return {
    phase: room.phase,
    hole: room.hole,
    host: room.host ?? '',
    config: room.config,
    players: publicPlayers(room),
  };
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, exceptId) {
  const data = JSON.stringify(msg);
  for (const p of room.players.values()) {
    if (p.id === exceptId) continue;
    if (p.ws.readyState === 1) p.ws.send(data);
  }
}

function broadcastState(room) {
  broadcast(room, { t: 'state', state: roomState(room) });
}

/** Oldest remaining player inherits the host role. */
function ensureHost(room) {
  if (room.host && room.players.has(room.host)) return;
  const first = room.players.values().next().value;
  room.host = first ? first.id : null;
}

function advanceHole(room) {
  room.hole += 1;
  for (const p of room.players.values()) {
    p.total += p.strokes;
    p.strokes = 0;
    p.state = 'idle';
    p.done = false;
  }
  room.advanceTimer = null;
  broadcastState(room);
}

function maybeAdvance(room) {
  if (room.phase !== 'playing' || room.advanceTimer) return;
  const players = [...room.players.values()];
  if (players.length === 0 || !players.every((p) => p.done)) return;
  broadcast(room, { t: 'countdown', seconds: 4 });
  room.advanceTimer = setTimeout(() => advanceHole(room), 4000);
}

function cancelAdvance(room) {
  if (room.advanceTimer) {
    clearTimeout(room.advanceTimer);
    room.advanceTimer = null;
  }
}

/** Resets every player's score. Used when a fresh game starts. */
function resetScores(room) {
  for (const p of room.players.values()) {
    p.strokes = 0;
    p.total = 0;
    p.state = 'idle';
    p.done = false;
  }
}

wss.on('connection', (ws) => {
  let player = null;
  let room = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.t === 'join') {
      const code = String(msg.room ?? '').toUpperCase().slice(0, 12) || 'LOBBY';
      if (!rooms.has(code)) {
        rooms.set(code, {
          code,
          // The first player to create a room fixes the course seed for everyone.
          seed: Number.isFinite(msg.seed) ? msg.seed >>> 0 : (Math.random() * 0xffffffff) >>> 0,
          hole: 1,
          phase: 'lobby',
          host: null,
          config: { ...DEFAULT_CONFIG },
          players: new Map(),
          advanceTimer: null,
        });
      }
      room = rooms.get(code);
      player = {
        id: `p${nextId++}`,
        name: String(msg.name ?? 'Player').slice(0, 18),
        hue: Number(msg.hue) || 200,
        strokes: 0,
        total: 0,
        state: 'idle',
        done: false,
        x: 0,
        y: 0,
        ws,
      };
      room.players.set(player.id, player);
      ensureHost(room);
      send(ws, { t: 'welcome', id: player.id, room: room.code, seed: room.seed, state: roomState(room) });
      broadcastState(room);
      return;
    }

    if (!player || !room) return;
    const isHost = room.host === player.id;

    switch (msg.t) {
      case 'pos':
        player.x = msg.x;
        player.y = msg.y;
        player.state = msg.state;
        broadcast(room, { t: 'pos', id: player.id, x: msg.x, y: msg.y, state: msg.state }, player.id);
        break;

      case 'stroke':
        player.strokes = Math.max(0, Math.min(999, msg.strokes | 0));
        broadcastState(room);
        break;

      case 'done':
        if (room.phase !== 'playing') break;
        player.strokes = Math.max(0, Math.min(999, msg.strokes | 0));
        player.state = msg.result === 'sunk' ? 'sunk' : 'lost';
        player.done = true;
        broadcastState(room);
        maybeAdvance(room);
        break;

      case 'ready':
        if (room.phase !== 'playing') break;
        player.done = true;
        broadcastState(room);
        maybeAdvance(room);
        break;

      // ---- host-only actions -------------------------------------------------
      case 'start':
        if (!isHost) break;
        cancelAdvance(room);
        room.phase = 'playing';
        room.hole = 1;
        resetScores(room);
        broadcastState(room);
        break;

      case 'lobby':
        if (!isHost) break;
        cancelAdvance(room);
        room.phase = 'lobby';
        resetScores(room);
        broadcastState(room);
        break;

      case 'config': {
        if (!isHost || !msg.config) break;
        const c = msg.config;
        if (c.aimPolicy === 'free' || c.aimPolicy === 'on' || c.aimPolicy === 'off') {
          room.config.aimPolicy = c.aimPolicy;
        }
        if (typeof c.allowRestart === 'boolean') room.config.allowRestart = c.allowRestart;
        broadcastState(room);
        break;
      }

      case 'kick': {
        if (!isHost || msg.id === player.id) break;
        const target = room.players.get(msg.id);
        if (!target) break;
        send(target.ws, { t: 'kicked', reason: 'The host removed you from the room.' });
        // Close after the message flushes; the close handler cleans up and rebroadcasts.
        setTimeout(() => target.ws.close(), 50);
        break;
      }

      case 'ping':
        send(ws, { t: 'pong' });
        break;
    }
  });

  ws.on('close', () => {
    if (!room || !player) return;
    room.players.delete(player.id);
    if (room.players.size === 0) {
      cancelAdvance(room);
      rooms.delete(room.code);
      return;
    }
    ensureHost(room);
    broadcastState(room);
    maybeAdvance(room);
  });
});

server.listen(PORT, () => {
  console.log(`Orbit Golf server listening on http://localhost:${PORT}  (ws path /ws)`);
});
