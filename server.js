const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-five-in-row-session-secret';
const APP_URL = process.env.APP_URL || 'https://plmnpix.uk/5inrow';
fs.mkdirSync(DATA_DIR, { recursive: true });

function readUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return []; }
}
function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}
function gravatarUrl(email) {
  const hash = crypto.createHash('md5').update(normalizeEmail(email)).digest('hex');
  return `https://www.gravatar.com/avatar/${hash}?d=identicon&s=160`;
}
function publicUser(user) {
  if (!user) return null;
  return { id: user.id, email: user.email, displayName: user.displayName, avatarUrl: user.avatarUrl, emailVerified: user.emailVerified };
}
function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
}
function createSession(userId) {
  const payload = Buffer.from(JSON.stringify({ userId, iat: Date.now() })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const index = part.indexOf('=');
    return index === -1 ? [part, ''] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }));
}
function getUserFromToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, mac] = token.split('.');
  if (sign(payload) !== mac) return null;
  let parsed;
  try { parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  return readUsers().find(user => user.id === parsed.userId) || null;
}
function currentUser(req) {
  return getUserFromToken(parseCookies(req.headers.cookie).fiveInRowSession);
}
function sessionCookie(token) {
  return `fiveInRowSession=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`;
}
function clearSessionCookie() {
  return 'fiveInRowSession=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}
function makeCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
function sendVerificationEmail(email, code) {
  // Real email delivery can be connected here with Resend/SMTP later.
  console.log(`[AUTH] Verification code for ${email}: ${code}`);
  console.log(`[AUTH] App URL: ${APP_URL}`);
}

app.post('/api/auth/request-code', (req, res) => {
  const email = normalizeEmail(req.body.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  const users = readUsers();
  let user = users.find(entry => entry.email === email);
  const code = makeCode();
  const expiresAt = Date.now() + 10 * 60 * 1000;
  if (!user) {
    user = {
      id: uuidv4(),
      email,
      displayName: email.split('@')[0].slice(0, 18),
      avatarUrl: gravatarUrl(email),
      emailVerified: false,
      verificationCodeHash: '',
      verificationExpiresAt: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    users.push(user);
  }
  user.avatarUrl = gravatarUrl(email);
  user.verificationCodeHash = crypto.createHash('sha256').update(code).digest('hex');
  user.verificationExpiresAt = expiresAt;
  user.updatedAt = new Date().toISOString();
  writeUsers(users);
  sendVerificationEmail(email, code);
  res.json({ ok: true, message: 'Verification code sent.', devCode: code });
});

app.post('/api/auth/verify-code', (req, res) => {
  const email = normalizeEmail(req.body.email);
  const code = String(req.body.code || '').trim();
  const users = readUsers();
  const user = users.find(entry => entry.email === email);
  if (!user) return res.status(404).json({ error: 'Account not found.' });
  if (!code || Date.now() > user.verificationExpiresAt) return res.status(400).json({ error: 'Code expired. Request a new code.' });
  const hash = crypto.createHash('sha256').update(code).digest('hex');
  if (hash !== user.verificationCodeHash) return res.status(400).json({ error: 'Incorrect code.' });
  user.emailVerified = true;
  user.verificationCodeHash = '';
  user.verificationExpiresAt = 0;
  user.updatedAt = new Date().toISOString();
  writeUsers(users);
  res.setHeader('Set-Cookie', sessionCookie(createSession(user.id)));
  res.json({ user: publicUser(user) });
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: publicUser(currentUser(req)) });
});

app.post('/api/auth/logout', (_req, res) => {
  res.setHeader('Set-Cookie', clearSessionCookie());
  res.json({ ok: true });
});

app.patch('/api/profile', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in first.' });
  const displayName = String(req.body.displayName || '').trim().slice(0, 18);
  if (!displayName) return res.status(400).json({ error: 'Display name is required.' });
  const users = readUsers();
  const stored = users.find(entry => entry.id === user.id);
  stored.displayName = displayName;
  stored.updatedAt = new Date().toISOString();
  writeUsers(users);
  res.json({ user: publicUser(stored) });
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

function createBoard(size) {
  return Array.from({ length: size }, () => Array(size).fill(0));
}

function checkWin(board, r, c, player, size) {
  const dirs = [[0,1],[1,0],[1,1],[1,-1]];
  for (const [dr, dc] of dirs) {
    const cells = [[r, c]];
    for (let i = 1; i < 5; i++) {
      const nr = r + dr*i, nc = c + dc*i;
      if (nr<0||nr>=size||nc<0||nc>=size||board[nr][nc]!==player) break;
      cells.push([nr, nc]);
    }
    for (let i = 1; i < 5; i++) {
      const nr = r - dr*i, nc = c - dc*i;
      if (nr<0||nr>=size||nc<0||nc>=size||board[nr][nc]!==player) break;
      cells.push([nr, nc]);
    }
    if (cells.length >= 5) return cells;
  }
  return null;
}

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function broadcast(room, data) {
  room.players.forEach(p => send(p, data));
}
function generateCode() {
  return Math.random().toString(36).substr(2, 5).toUpperCase();
}
function wsUser(ws) {
  return ws.user ? publicUser(ws.user) : null;
}

wss.on('connection', (ws, req) => {
  ws.id = uuidv4();
  ws.roomCode = null;
  ws.user = getUserFromToken(parseCookies(req.headers.cookie).fiveInRowSession);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, payload = {} } = msg;

    if (type === 'CREATE_ROOM') {
      if (!ws.user?.emailVerified) return send(ws, { type: 'ERROR', payload: { message: 'Please sign in with a verified email first.' } });
      const code = generateCode();
      const size = payload.size || 15;
      const room = {
        code,
        players: [ws],
        board: createBoard(size),
        current: 1,
        size,
        scores: [0, 0],
        moveCount: 0,
        status: 'waiting',
        names: [ws.user.displayName || ws.user.email, ''],
        avatars: [ws.user.avatarUrl, ''],
        users: [wsUser(ws), null]
      };
      rooms.set(code, room);
      ws.roomCode = code;
      ws.playerNum = 1;
      send(ws, { type: 'ROOM_CREATED', payload: { code, playerNum: 1, size, profile: wsUser(ws) } });
    }

    else if (type === 'JOIN_ROOM') {
      if (!ws.user?.emailVerified) return send(ws, { type: 'ERROR', payload: { message: 'Please sign in with a verified email first.' } });
      const code = String(payload.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, { type: 'ERROR', payload: { message: 'Room not found!' } });
      if (room.players.length >= 2) return send(ws, { type: 'ERROR', payload: { message: 'Room is full!' } });
      if (room.users[0]?.id === ws.user.id) return send(ws, { type: 'ERROR', payload: { message: 'Open this room on another account to join.' } });
      room.players.push(ws);
      room.names[1] = ws.user.displayName || ws.user.email;
      room.avatars[1] = ws.user.avatarUrl;
      room.users[1] = wsUser(ws);
      ws.roomCode = code;
      ws.playerNum = 2;
      room.status = 'playing';

      send(ws, { type: 'ROOM_JOINED', payload: { code, playerNum: 2, size: room.size, names: room.names, avatars: room.avatars, users: room.users } });
      send(room.players[0], { type: 'OPPONENT_JOINED', payload: { name: room.names[1], names: room.names, avatars: room.avatars, users: room.users } });
      broadcast(room, { type: 'GAME_START', payload: { board: room.board, current: 1, names: room.names, avatars: room.avatars, users: room.users, size: room.size, scores: room.scores } });
    }

    else if (type === 'MOVE') {
      const room = rooms.get(ws.roomCode);
      if (!room || room.status !== 'playing') return;
      if (room.current !== ws.playerNum) return send(ws, { type: 'ERROR', payload: { message: 'Not your turn!' } });
      const { r, c } = payload;
      if (r < 0 || r >= room.size || c < 0 || c >= room.size) return;
      if (room.board[r][c] !== 0) return;
      const mover = room.current;
      room.board[r][c] = mover;
      room.moveCount++;
      const win = checkWin(room.board, r, c, mover, room.size);
      if (win) {
        room.scores[mover - 1]++;
        room.status = 'over';
        broadcast(room, { type: 'MOVE_MADE', payload: { r, c, player: mover, current: mover, moveCount: room.moveCount } });
        broadcast(room, { type: 'GAME_OVER', payload: { winner: mover, winCells: win, scores: room.scores } });
        return;
      }
      if (room.moveCount === room.size * room.size) {
        room.status = 'over';
        broadcast(room, { type: 'MOVE_MADE', payload: { r, c, player: mover, current: mover, moveCount: room.moveCount } });
        broadcast(room, { type: 'GAME_OVER', payload: { winner: 0, winCells: [], scores: room.scores } });
        return;
      }
      room.current = mover === 1 ? 2 : 1;
      broadcast(room, { type: 'MOVE_MADE', payload: { r, c, player: mover, current: room.current, moveCount: room.moveCount } });
    }

    else if (type === 'REMATCH') {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      if (!room.rematchVotes) room.rematchVotes = new Set();
      room.rematchVotes.add(ws.playerNum);
      if (room.rematchVotes.size === 2) {
        room.board = createBoard(room.size);
        room.current = 1;
        room.moveCount = 0;
        room.status = 'playing';
        room.rematchVotes = new Set();
        broadcast(room, { type: 'GAME_START', payload: { board: room.board, current: 1, names: room.names, avatars: room.avatars, users: room.users, size: room.size, scores: room.scores } });
      } else {
        const opponent = room.players.find(p => p !== ws);
        send(opponent, { type: 'REMATCH_REQUEST', payload: {} });
      }
    }

    else if (type === 'PING') send(ws, { type: 'PONG' });
  });

  ws.on('close', () => {
    if (!ws.roomCode) return;
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const opponent = room.players.find(p => p !== ws);
    if (opponent) send(opponent, { type: 'OPPONENT_LEFT', payload: {} });
    rooms.delete(ws.roomCode);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Five in Row server running on http://localhost:${PORT}`));
