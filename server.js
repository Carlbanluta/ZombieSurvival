// Last Light multiplayer server: serves index.html, relays game messages, keeps presence and the leaderboard.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const BOARD_FILE = path.join(ROOT, 'board.json');
const TOPICS = new Set(['hello', 'chat', 'shot', 'hit', 'down', 'rev', 'zs', 'zh', 'zk', 'zd']);

const DATA_DIR = process.env.DATA_DIR || ROOT;
const ACCT_FILE = path.join(DATA_DIR, 'accounts.json');
let acct = { secret: '', users: {} };
try { acct = JSON.parse(fs.readFileSync(ACCT_FILE, 'utf8')); } catch (e) {}
if (!acct.users) acct.users = {};
if (!acct.secret) { acct.secret = crypto.randomBytes(32).toString('hex'); }
let acctDirty = true;
const TOKEN_TTL = 90 * 24 * 3600 * 1000;
const hits = new Map();

function hashPw(pw, salt) { return crypto.scryptSync(pw, salt, 64).toString('hex'); }
function makeToken(key) {
  const body = Buffer.from(key + '|' + (Date.now() + TOKEN_TTL)).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', acct.secret).update(body).digest('base64url');
}
function readToken(tok) {
  const [body, sig] = String(tok || '').split('.');
  if (!body || !sig) return null;
  const good = crypto.createHmac('sha256', acct.secret).update(body).digest('base64url');
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  const [key, exp] = Buffer.from(body, 'base64url').toString().split('|');
  if (!(Number(exp) > Date.now()) || !acct.users[key]) return null;
  return key;
}
function limited(ip, max) {
  const now = Date.now(), h = (hits.get(ip) || []).filter(t => now - t < 60000);
  h.push(now); hits.set(ip, h); return h.length > max;
}
function body(req, cb) {
  let n = 0; const chunks = [];
  req.on('data', c => { n += c.length; if (n > 64 * 1024) { req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { cb(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { cb(null); } });
}
function json(res, code, o) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); }

function api(req, res, u) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (u === '/api/register' || u === '/api/login') {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    if (limited(ip, 10)) return json(res, 429, { error: 'Too many attempts. Wait a minute and try again.' });
    return body(req, m => {
      if (!m) return json(res, 400, { error: 'Bad request' });
      const name = String(m.username || '').replace(/[^\w .-]/g, '').trim().slice(0, 14);
      const pw = String(m.password || '');
      const key = name.toLowerCase();
      if (u === '/api/register') {
        if (name.length < 3) return json(res, 400, { error: 'Username must be 3 to 14 letters, numbers, spaces, . _ -' });
        if (pw.length < 6 || pw.length > 100) return json(res, 400, { error: 'Password must be at least 6 characters.' });
        if (acct.users[key]) return json(res, 409, { error: 'That username is taken.' });
        if (Object.keys(acct.users).length >= 20000) return json(res, 503, { error: 'Registration is full.' });
        const salt = crypto.randomBytes(16).toString('hex');
        acct.users[key] = { name, salt, hash: hashPw(pw, salt), uid: crypto.randomBytes(8).toString('hex'), save: null, at: Date.now() };
        acctDirty = true;
        return json(res, 200, { token: makeToken(key), name, uid: acct.users[key].uid, save: null });
      }
      const user = acct.users[key];
      const ok = user && crypto.timingSafeEqual(Buffer.from(hashPw(pw, user.salt), 'hex'), Buffer.from(user.hash, 'hex'));
      if (!ok) return json(res, 401, { error: 'Wrong username or password.' });
      return json(res, 200, { token: makeToken(key), name: user.name, uid: user.uid, save: user.save });
    });
  }
  if (u === '/api/save') {
    const key = readToken((req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!key) return json(res, 401, { error: 'Please sign in again.' });
    const user = acct.users[key];
    if (req.method === 'GET') return json(res, 200, { save: user.save, name: user.name, uid: user.uid });
    if (req.method === 'PUT') {
      if (limited('save:' + key, 60)) return json(res, 429, { error: 'Slow down.' });
      return body(req, m => {
        const sv = m && m.save;
        if (!sv || typeof sv !== 'object' || Array.isArray(sv) || JSON.stringify(sv).length > 20000) return json(res, 400, { error: 'Bad save' });
        const sc = x => ((x && x.xp) | 0) + ((x && x.tk) | 0);
        if (user.save && sc(sv) < sc(user.save)) return json(res, 409, { error: 'Newer progress exists on your account.', save: user.save });
        user.save = sv; user.at = Date.now(); acctDirty = true;
        json(res, 200, { ok: true });
      });
    }
    return json(res, 405, { error: 'Method not allowed' });
  }
  json(res, 404, { error: 'not found' });
}

let board = {};
try { board = JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8')); } catch (e) {}
let boardDirty = false, peersDirty = false;

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u.startsWith('/api/')) return api(req, res, u);
  if (u === '/' || u === '/index.html') {
    fs.readFile(path.join(ROOT, 'index.html'), (err, data) => {
      if (err) { res.writeHead(500); return res.end('index.html missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  } else if (u === '/health') { res.writeHead(200); res.end('ok'); }
  else { res.writeHead(404); res.end('not found'); }
});

const wss = new WebSocketServer({ server, maxPayload: 32 * 1024 });
const clients = new Map();

function send(ws, o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)); }
function broadcast(o) { const m = JSON.stringify(o); wss.clients.forEach(c => { if (c.readyState === 1) c.send(m); }); }
function top() {
  return Object.values(board).sort((a, b) => b.kills - a.kills).slice(0, 10)
    .map(r => ({ name: r.name, kills: r.kills, cash: r.cash, level: r.level }));
}
const int = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));

wss.on('connection', ws => {
  const st = { peer: crypto.randomBytes(5).toString('hex'), presence: {}, uid: null, tokens: 400, t: Date.now() };
  clients.set(ws, st);
  send(ws, { t: 'welcome', peer: st.peer });
  send(ws, { t: 'board', rows: top() });
  peersDirty = true;

  ws.on('message', raw => {
    const now = Date.now();
    st.tokens = Math.min(400, st.tokens + (now - st.t) * 0.4); st.t = now;
    if (st.tokens < 1) return;
    st.tokens--;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;

    if (m.t === 'hi') {
      st.uid = String(m.id || '').replace(/[^\w-]/g, '').slice(0, 40) || null;
    } else if (m.t === 'emit') {
      if (!TOPICS.has(m.topic)) return;
      broadcast({ t: 'msg', topic: m.topic, data: m.data, peer: st.peer });
    } else if (m.t === 'pres') {
      const patch = m.patch;
      if (!patch || typeof patch !== 'object') return;
      Object.keys(patch).slice(0, 20).forEach(k => {
        const v = patch[k];
        if (v === null) delete st.presence[k];
        else if (typeof v === 'number' && isFinite(v)) st.presence[k] = v;
        else if (typeof v === 'string') st.presence[k] = v.slice(0, 20);
        else if (typeof v === 'boolean') st.presence[k] = v;
      });
      peersDirty = true;
    } else if (m.t === 'board') {
      if (!st.uid || !m.d) return;
      const prev = board[st.uid];
      if (!prev && Object.keys(board).length >= 5000) return;
      const name = String(m.d.name || '').replace(/[<>]/g, '').trim().slice(0, 14);
      if (!name) return;
      const kills = int(m.d.kills, 1e7);
      if (prev) {
        const secs = Math.max(1, (now - prev.at) / 1000);
        if (kills > prev.kills + 60 + secs * 3) return; // reject impossible jumps
      } else if (kills > 20000) return;
      board[st.uid] = { name, kills: Math.max(kills, prev ? prev.kills : 0), cash: int(m.d.cash, 1e9), level: int(m.d.level, 999), at: now };
      boardDirty = true;
    }
  });

  ws.on('close', () => { clients.delete(ws); peersDirty = true; });
  ws.on('error', () => {});
});

setInterval(() => {
  if (peersDirty) {
    peersDirty = false;
    broadcast({ t: 'peers', peers: [...clients.values()].map(c => ({ peer: c.peer, presence: c.presence })) });
  }
}, 100);

setInterval(() => {
  if (boardDirty) {
    boardDirty = false;
    broadcast({ t: 'board', rows: top() });
    fs.writeFile(BOARD_FILE, JSON.stringify(board), () => {});
  }
}, 1500);

setInterval(() => {
  if (acctDirty) { acctDirty = false; fs.writeFile(ACCT_FILE + '.tmp', JSON.stringify(acct), err => { if (!err) fs.rename(ACCT_FILE + '.tmp', ACCT_FILE, () => {}); }); }
  const now = Date.now(); hits.forEach((v, k) => { if (!v.some(t => now - t < 60000)) hits.delete(k); });
}, 2000);

setInterval(() => { wss.clients.forEach(c => { if (c.readyState === 1) c.ping(); }); }, 30000);

server.listen(PORT, () => console.log('Last Light server on port ' + PORT));
