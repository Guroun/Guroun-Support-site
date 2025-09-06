const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');
const net = require('net');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Basic config and secrets
const CONFIG_DIR = path.join(__dirname, 'config');
const SECRET_FILE = path.join(CONFIG_DIR, 'secret.json');

function ensureSecrets() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(SECRET_FILE)) {
    const defaults = {
      moderatorCode: 'GUR0UN-2025',
      jwtSecret: 'change-this-secret-to-something-random'
    };
    fs.writeFileSync(SECRET_FILE, JSON.stringify(defaults, null, 2), 'utf8');
    return defaults;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8'));
    if (!parsed.jwtSecret || !parsed.moderatorCode) throw new Error('Invalid secret file');
    return parsed;
  } catch (e) {
    const defaults = {
      moderatorCode: 'GUR0UN-2025',
      jwtSecret: 'change-this-secret-to-something-random'
    };
    fs.writeFileSync(SECRET_FILE, JSON.stringify(defaults, null, 2), 'utf8');
    return defaults;
  }
}

const secrets = ensureSecrets();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Serve static frontend
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// Uploads
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '7d', immutable: false }));
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const id = nanoid(10);
    const ext = path.extname(file.originalname || '').slice(0, 10);
    cb(null, `${Date.now()}-${id}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// In-memory data stores (simple demo; for production, use DB)
/** @type {Map<string, { id: string, createdAt: number, status: 'open'|'assigned'|'closed', claimedBy?: string|null, messages: Array<{ sender: 'user'|'moderator'|'system', text: string, ts: number, by?: string }> }> } */
const tickets = new Map();
/** @type {Map<string, { id: string, displayName: string }>} */
const moderators = new Map();

// Persistence layer (file-based JSON)
const DATA_DIR = path.join(__dirname, 'data');
const TICKETS_DIR = path.join(DATA_DIR, 'tickets');
const TICKETS_FILE = path.join(DATA_DIR, 'tickets.json'); // legacy single-file storage (migration)
const MODS_FILE = path.join(DATA_DIR, 'moderators.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(TICKETS_DIR)) fs.mkdirSync(TICKETS_DIR, { recursive: true });
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJSONAtomic(file, obj) {
  const json = JSON.stringify(obj, null, 2);
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.writeFileSync(file, json, 'utf8'); } catch {}
  }
}

let saveTicketsTimer = null;
let saveModeratorsTimer = null;

function saveTicketsNow() {
  ensureDataDir();
  // write each ticket to its own file
  for (const t of tickets.values()) {
    const file = path.join(TICKETS_DIR, `${t.id}.json`);
    writeJSONAtomic(file, t);
  }
}

function saveModeratorsNow() {
  ensureDataDir();
  writeJSONAtomic(MODS_FILE, Array.from(moderators.values()));
}

function scheduleSaveTickets() {
  if (saveTicketsTimer) return;
  saveTicketsTimer = setTimeout(() => {
    saveTicketsTimer = null;
    saveTicketsNow();
  }, 300);
}

function scheduleSaveModerators() {
  if (saveModeratorsTimer) return;
  saveModeratorsTimer = setTimeout(() => {
    saveModeratorsTimer = null;
    saveModeratorsNow();
  }, 300);
}

function loadPersisted() {
  ensureDataDir();
  // Load tickets from per-file storage; if empty, migrate from legacy file
  tickets.clear();
  const entries = fs.readdirSync(TICKETS_DIR, { withFileTypes: true }).filter(d => d.isFile() && d.name.endsWith('.json'));
  if (entries.length > 0) {
    for (const ent of entries) {
      try {
        const t = readJSON(path.join(TICKETS_DIR, ent.name), null);
        if (t && t.id) tickets.set(t.id, t);
      } catch {}
    }
  } else if (fs.existsSync(TICKETS_FILE)) {
    const ticketArray = readJSON(TICKETS_FILE, []);
  for (const t of ticketArray) {
    if (t && t.id) tickets.set(t.id, t);
  }
    // write them out in the new format immediately
    saveTicketsNow();
  }

  const modArray = readJSON(MODS_FILE, []);
  moderators.clear();
  for (const m of modArray) {
    if (m && m.id && m.displayName) moderators.set(m.id, { id: m.id, displayName: m.displayName });
  }
}

// Load from disk on startup
loadPersisted();

// Graceful shutdown hooks to persist data on exit
let shuttingDown = false;
function flushAllSync() {
  try { saveTicketsNow(); } catch {}
  try { saveModeratorsNow(); } catch {}
}
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (saveTicketsTimer) { clearTimeout(saveTicketsTimer); saveTicketsTimer = null; }
    if (saveModeratorsTimer) { clearTimeout(saveModeratorsTimer); saveModeratorsTimer = null; }
    flushAllSync();
  } finally {
    server.close(() => process.exit(0));
    const t = setTimeout(() => process.exit(0), 500);
    if (typeof t.unref === 'function') t.unref();
  }
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('beforeExit', flushAllSync);
process.on('exit', flushAllSync);
process.on('uncaughtException', (err) => { try { console.error(err); } catch {} finally { flushAllSync(); process.exit(1); } });
process.on('unhandledRejection', (reason) => { try { console.error(reason); } catch {} finally { flushAllSync(); process.exit(1); } });

function authModerator(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, secrets.jwtSecret);
    req.moderator = payload; // { modId, displayName }
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Routes
app.post('/api/moderator/register', (req, res) => {
  const { code, displayName } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Code required' });
  if (code !== secrets.moderatorCode) return res.status(403).json({ error: 'Wrong code' });
  const modId = nanoid(12);
  const name = (displayName && String(displayName).trim()) || `Модератор-${modId.slice(-4)}`;
  moderators.set(modId, { id: modId, displayName: name });
  scheduleSaveModerators();
  const token = jwt.sign({ modId, displayName: name }, secrets.jwtSecret, { expiresIn: '7d' });
  res.json({ token, displayName: name });
});

app.get('/api/tickets', authModerator, (req, res) => {
  const list = Array.from(tickets.values())
    .filter(t => t.status !== 'closed')
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(t => ({ id: t.id, createdAt: t.createdAt, status: t.status, claimedBy: t.claimedBy || null }));
  res.json({ tickets: list });
});

app.post('/api/tickets/new', (req, res) => {
  const id = nanoid(8);
  const now = Date.now();
  const ticket = { id, createdAt: now, status: 'open', claimedBy: null, messages: [{ sender: 'system', text: 'Тикет создан. Ожидайте модератора…', ts: now }] };
  tickets.set(id, ticket);
  scheduleSaveTickets();
  io.to('moderators').emit('ticket:new', { id, createdAt: now });
  res.json({ ticketId: id });
});

// Public: get ticket status
app.get('/api/tickets/status', (req, res) => {
  const id = String(req.query.id || '');
  const t = tickets.get(id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const claimedByName = t.claimedBy ? ((moderators.get(t.claimedBy) || {}).displayName || null) : null;
  res.json({ id, status: t.status, claimedByName });
});

app.post('/api/tickets/claim', authModerator, (req, res) => {
  const { ticketId } = req.body || {};
  const ticket = tickets.get(ticketId);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (ticket.status === 'closed') return res.status(400).json({ error: 'Ticket is closed' });
  if (ticket.claimedBy && ticket.claimedBy !== req.moderator.modId) {
    return res.status(409).json({ error: 'Already claimed' });
  }
  ticket.status = 'assigned';
  ticket.claimedBy = req.moderator.modId;
  const ts = Date.now();
  const sysMsg = { sender: 'system', text: `Модератор ${req.moderator.displayName} подключился.`, ts };
  ticket.messages.push(sysMsg);
  scheduleSaveTickets();
  io.to(`ticket:${ticketId}`).emit('ticket:claimed', { ticketId, by: req.moderator.displayName, ts });
  io.to(`ticket:${ticketId}`).emit('message', { ...sysMsg, ticketId });
  io.to('moderators').emit('ticket:updated', { id: ticketId, status: 'assigned' });
  res.json({ ok: true });
});

app.post('/api/tickets/close', authModerator, (req, res) => {
  const { ticketId } = req.body || {};
  const ticket = tickets.get(ticketId);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  ticket.status = 'closed';
  const ts = Date.now();
  const sysMsg = { sender: 'system', text: 'Тикет закрыт.', ts };
  ticket.messages.push(sysMsg);
  scheduleSaveTickets();
  io.to(`ticket:${ticketId}`).emit('ticket:closed', { ticketId, ts });
  io.to(`ticket:${ticketId}`).emit('message', { ...sysMsg, ticketId });
  io.to('moderators').emit('ticket:updated', { id: ticketId, status: 'closed' });
  res.json({ ok: true });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const file = req.file;
  const url = `/uploads/${file.filename}`;
  const isImage = /^image\//.test(file.mimetype || '');
  const isText = /^(text\/|application\/(json|xml|yaml|x-yaml|toml))/.test(file.mimetype || '');
  const isAudio = /^audio\//.test(file.mimetype || '') || /\.(mp3|wav|ogg)$/i.test(file.originalname || '');
  res.json({ url, name: file.originalname, mime: file.mimetype, size: file.size, isImage, isText, isAudio });
});

// Socket.IO logic
io.on('connection', (socket) => {
  // role: 'user' | 'moderator'
  const { role, ticketId, token } = socket.handshake.query;

  if (role === 'moderator') {
    // Verify token
    try {
      const payload = jwt.verify(String(token || ''), secrets.jwtSecret);
      socket.data.role = 'moderator';
      socket.data.modId = payload.modId;
      socket.data.displayName = payload.displayName;
      socket.join('moderators');
      socket.emit('moderator:ready', { displayName: payload.displayName });

      socket.on('mod:join', ({ ticketId: joinId }) => {
        if (!joinId || !tickets.has(joinId)) return;
        socket.join(`ticket:${joinId}`);
        socket.emit('ticket:history', { ticketId: joinId, messages: tickets.get(joinId).messages });
        const t = tickets.get(joinId);
        if (t && t.status !== 'closed') {
          io.to(`ticket:${joinId}`).emit('ticket:claimed', { ticketId: joinId, by: socket.data.displayName, ts: Date.now() });
        }
      });

      socket.on('message', ({ ticketId: tId, text, attachment }) => {
        if (!tId || (!text && !attachment)) return;
        const ticket = tickets.get(tId);
        if (!ticket) return;
        const msg = { sender: 'moderator', text: String(text || '').slice(0, 2000), ts: Date.now(), by: socket.data.displayName };
        if (attachment && attachment.url) msg.attachment = attachment;
        ticket.messages.push(msg);
        scheduleSaveTickets();
        io.to(`ticket:${tId}`).emit('message', { ...msg, ticketId: tId });
      });
    } catch (e) {
      socket.disconnect(true);
    }
    return;
  }

  // Default: user side
  if (!ticketId || !tickets.has(String(ticketId))) {
    socket.emit('error', 'INVALID_TICKET');
    socket.disconnect(true);
    return;
  }
  const id = String(ticketId);
  socket.data.role = 'user';
  socket.data.ticketId = id;
  socket.join(`ticket:${id}`);

  // send history + status
  const t = tickets.get(id);
  const claimedByName = t && t.claimedBy ? ((moderators.get(t.claimedBy) || {}).displayName || null) : null;
  socket.emit('ticket:history', { ticketId: id, status: t ? t.status : 'open', claimedByName, messages: t ? t.messages : [] });

  socket.on('message', ({ text, attachment }) => {
    if (!text && !attachment) return;
    const ticket = tickets.get(id);
    if (!ticket) return;
    const msg = { sender: 'user', text: String(text || '').slice(0, 2000), ts: Date.now() };
    if (attachment && attachment.url) msg.attachment = attachment;
    ticket.messages.push(msg);
    scheduleSaveTickets();
    io.to(`ticket:${id}`).emit('message', { ...msg, ticketId: id });
  });
});

// Start server on a free port (3000+)
function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => tester.close(() => resolve(true)))
      .listen(port, '0.0.0.0');
  });
}

async function pickFreePort(startPort) {
  const base = Number(process.env.PORT) || startPort;
  for (let p = base, tries = 0; tries < 10; p++, tries++) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(p)) return p;
  }
  return base; // fallback
}

(async () => {
  const port = await pickFreePort(3000);
  server.listen(port, () => {
    console.log(`Support server running on http://localhost:${port}`);
  });
})(); 