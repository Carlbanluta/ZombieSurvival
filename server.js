// Last Light multiplayer server: serves index.html, relays game messages, keeps presence and the leaderboard.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const BOARD_FILE = path.join(ROOT, 'board.json');
const TOPICS = new Set(['hello', 'chat', 'shot', 'hit', 'down', 'rev', 'zs', 'zh', 'zk', 'zd']);

let board = {};
try { board = JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8')); } catch (e) {}
let boardDirty = false, peersDirty = false;

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
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

setInterval(() => { wss.clients.forEach(c => { if (c.readyState === 1) c.ping(); }); }, 30000);

server.listen(PORT, () => console.log('Last Light server on port ' + PORT));
