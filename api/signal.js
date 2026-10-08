// Signaling only. Relays WebRTC offer/answer/ICE. NEVER sees chat text.
// State is in-memory (best effort on serverless; see README).
const rooms = new Map();
const IDLE = 10 * 60 * 1000, MAX = 10;
module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const now = Date.now();
  for (const [k, r] of rooms) if (now - r.t > IDLE) rooms.delete(k);
  const q = req.method === 'GET' ? req.query : (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {});
  const code = String(q.room || '').toUpperCase(), peer = String(q.peer || '').slice(0, 40);
  if (!/^[A-HJ-NP-Z2-9]{6,12}$/.test(code) || !/^[\w-]{4,40}$/.test(peer)) return res.status(400).json({ error: 'bad request' });
  if (q.action === 'ice') { // TURN relay config. Set TURN_URL/TURN_USER/TURN_PASS in Vercel env to use your own; otherwise public best-effort relay.
    const e = process.env, ice = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }];
    if (e.TURN_URL) ice.push({ urls: e.TURN_URL.split(','), username: e.TURN_USER, credential: e.TURN_PASS });
    else ice.push({ urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turns:openrelay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' });
    return res.json({ iceServers: ice });
  }
  if (q.action === 'create') {
    if (!rooms.has(code)) rooms.set(code, { t: now, ttl: [1e4, 6e4, 3e5, 36e5, 864e5].includes(+q.ttl) ? +q.ttl : 3e5, peers: {} });
    return res.json({ ok: true });
  }
  const r = rooms.get(code);
  if (!r) return res.status(404).json({ error: 'room not found' });
  r.t = now;
  for (const id in r.peers) if (now - r.peers[id].seen > 20000) delete r.peers[id];
  if (q.action === 'join') {
    if (!r.peers[peer] && Object.keys(r.peers).length >= MAX) return res.status(429).json({ error: 'room full' });
    const others = Object.keys(r.peers).filter(i => i !== peer);
    r.peers[peer] = { seen: now, q: [] };
    return res.json({ ok: true, ttl: r.ttl, peers: others });
  }
  const me = r.peers[peer];
  if (!me) return res.status(410).json({ error: 'not joined' });
  me.seen = now;
  if (q.action === 'poll') { const m = me.q; me.q = []; return res.json({ msgs: m }); }
  if (q.action === 'send') {
    const to = r.peers[q.to];
    if (to && JSON.stringify(q.data || '').length < 20000) to.q.push({ from: peer, type: String(q.type).slice(0, 10), data: q.data });
    return res.json({ ok: true });
  }
  if (q.action === 'leave') { delete r.peers[peer]; return res.json({ ok: true }); }
  res.status(400).json({ error: 'bad action' });
};
