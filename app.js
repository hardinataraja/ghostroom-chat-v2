'use strict';
// NOTE: full mesh WebRTC: every user connects to every other user. Load grows ~N^2; best for 2-5 users (MAX 10 enforced by server).
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', TTLS = [['10s', 1e4], ['1m', 6e4], ['5m', 3e5], ['1h', 36e5], ['24h', 864e5]];
let ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }];
const S = { room: '', me: '', id: '', ttl: 3e5, peers: {}, msgs: [], poll: null, on: false, snd: false, rate: [], last: 0, retry: null };
let ttlSel = 3e5, audio;
const ls = { get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
const rid = n => { const a = new Uint32Array(n); crypto.getRandomValues(a); return [...a].map(x => ALPHA[x % ALPHA.length]).join(''); };
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n);
const show = id => { $$('.screen').forEach(e => e.classList.toggle('on', e.id === id)); };
const pad = n => String(n).padStart(2, '0'), hm = t => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const err = (t, b, retry) => { $('#et').textContent = '> ' + t; $('#eb').textContent = b; S.retry = retry || null; $('#retry').hidden = !retry; show('error'); };
const api = async (action, extra = {}, get) => {
  const p = { action, room: S.room, peer: S.id, ...extra };
  const r = get ? await fetch('/api/signal?' + new URLSearchParams(p), { cache: 'no-store' }) : await fetch('/api/signal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(j.error || 'http'), { status: r.status }); return j;
};
const link = () => `${location.origin}/?room=${S.room}`;
const copy = async t => { try { await navigator.clipboard.writeText(t); } catch { const a = document.createElement('textarea'); a.value = t; document.body.appendChild(a); a.select(); try { document.execCommand('copy'); } catch {} a.remove(); } };
const flash = (el, t) => { el.textContent = t; setTimeout(() => el.textContent = '', 2500); };
const supported = () => !!(window.RTCPeerConnection && crypto.getRandomValues && window.fetch);

// ---- messages / expiry ----
function cleanupExpiredMessages() {
  const n = Date.now(), b = S.msgs.length; S.msgs = S.msgs.filter(m => !m.expiresAt || m.expiresAt > n);
  ls.set('ghostroom_messages', S.msgs.filter(m => m.expiresAt && !m.kind && m.room === S.room)); if (b !== S.msgs.length) render();
}
function addMsg(m) { S.msgs.push(m); ls.set('ghostroom_messages', S.msgs.filter(x => x.expiresAt && !x.kind && x.room === S.room)); render(); }
const sys = t => addMsg({ sys: true, text: t, createdAt: Date.now() });
function render() {
  const log = $('#log'); log.textContent = '';
  for (const m of S.msgs) { if (m.kind) { log.append(v2.node(m)); continue; }
    const d = document.createElement('div'); d.className = 'm' + (m.sys ? ' sys' : m.sender === S.me && m.mine ? ' me' : '');
    const h = document.createElement('small'), b = document.createElement('span');
    h.textContent = m.sys ? '[ SYSTEM ]' : `[${hm(m.createdAt)}] ${m.sender}`; b.textContent = m.sys ? m.text : '> ' + m.text; d.append(h, b); log.append(d);
  } log.scrollTop = log.scrollHeight;
}
function stat() {
  const n = Object.values(S.peers).filter(p => p.dc && p.dc.readyState === 'open').length, c = Object.values(S.peers).some(p => p.pc && ['connecting', 'new'].includes(p.pc.connectionState));
  $('#status').textContent = n ? '● CONNECTED' : c ? '● CONNECTING' : S.on ? '● WAITING' : '● DISCONNECTED';
  $('#status').style.color = n ? 'var(--g)' : c ? 'var(--c)' : 'var(--w)';
  const left = Math.max(0, 6e5 - (Date.now() - S.last)), m = Math.floor(left / 6e4), s = Math.floor(left % 6e4 / 1e3);
  $('#info').textContent = `ROOM: ACTIVE | USERS: ${n + 1} | P2P: ${n ? 'LINK UP' : 'NONE'} | ENC: WEBRTC DTLS | PURGE: ${pad(m)}:${pad(s)} | TTL: ${TTLS.find(t => t[1] === S.ttl)?.[0] || ''}`;
}

// ---- WebRTC ----
// Non-trickle ICE: wait until candidates are gathered so offer/answer carry them (avoids out-of-order signaling races).
const gathered = pc => new Promise(r => { if (pc.iceGatheringState === 'complete') return r(); const t = setTimeout(r, 5000); pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); r(); } }); });
const sig = (to, type, data) => api('send', { to, type, data }).catch(() => {});
function mk(pid, init) {
  if (S.peers[pid]) return S.peers[pid];
  const pc = new RTCPeerConnection({ iceServers: ICE }), p = S.peers[pid] = { id: pid, pc, name: pid.slice(0, 6), dc: null };
  pc.onicecandidate = e => { if (e.candidate) (p.ct ||= new Set()).add(e.candidate.type); };
  pc.onconnectionstatechange = () => { if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) drop(pid, pc.connectionState === 'failed'); stat(); };
  const wire = dc => {
    p.dc = dc; dc.onopen = () => { dc.send(JSON.stringify({ t: 'hi', n: S.me, e: S.endsAt, o: S.owner ? 1 : 0 })); stat(); };
    dc.onclose = () => drop(pid);
    dc.onmessage = e => {
      let d; try { d = JSON.parse(e.data); } catch { return; }
      if (d.t === 'hi') { p.own = d.o === 1; if (+d.e > Date.now() && +d.e < Date.now() + 9e7 && !S.endsAt) S.endsAt = +d.e; p.name = clean(d.n, 20) || p.name; if (!p.hi) { p.hi = 1; sys(`${p.name} joined the room.`); } }
      else if (v2.rx(p, d)) {}
      else if (d.t === 'ty') { $('#typing').textContent = `> ${p.name} is typing...`; clearTimeout(p.ty); p.ty = setTimeout(() => $('#typing').textContent = '', 2500); }
      else if (d.t === 'm' && typeof d.text === 'string' && d.text.length <= 2000) {
        const now = Date.now(); S.last = now;
        addMsg({ id: clean(d.id, 40), room: S.room, sender: p.name, text: d.text, createdAt: now, expiresAt: now + S.ttl }); $('#typing').textContent = '';
        if (S.snd) try { (audio ||= new AudioContext()); const o = audio.createOscillator(); o.connect(audio.destination); o.frequency.value = 880; o.start(); o.stop(audio.currentTime + .08); } catch {}
      } stat();
    };
  };
  if (init) wire(pc.createDataChannel('chat')); else pc.ondatachannel = e => wire(e.channel);
  return p;
}
function drop(pid, failed) {
  const p = S.peers[pid]; if (!p) return; delete S.peers[pid]; try { p.pc.close(); } catch {}
  if (p.hi) sys(`${p.name} disconnected.`); else if (failed) sys('Connection to a peer failed. Local candidates: ' + [...(p.ct || [])].join(',') + ' (no "relay" = TURN unreachable or credentials rejected).'); stat();
}
async function onSignal(m) {
  try {
    if (m.type === 'offer') { const p = mk(m.from, false); await p.pc.setRemoteDescription(m.data); const a = await p.pc.createAnswer(); await p.pc.setLocalDescription(a); await gathered(p.pc); sig(m.from, 'answer', p.pc.localDescription); }
    else if (m.type === 'answer' && S.peers[m.from]) await S.peers[m.from].pc.setRemoteDescription(m.data);
    else if (m.type === 'ice' && S.peers[m.from]) await S.peers[m.from].pc.addIceCandidate(m.data);
  } catch {}
}
async function loop() {
  if (!S.on) return;
  try { const r = await api('poll', {}, true); for (const m of r.msgs) await onSignal(m); S.fails = 0; }
  catch (e) { if (e.status === 410 || e.status === 404) { return reconnect(); } if (++S.fails > 5) { $('#status').textContent = '● RECONNECTING'; } }
  S.poll = setTimeout(loop, 1000);
}
async function reconnect() { try { await api('create', { ttl: S.ttl }); const j = await api('join'); for (const id of j.peers) if (!S.peers[id]) { const p = mk(id, true); const o = await p.pc.createOffer(); await p.pc.setLocalDescription(o); await gathered(p.pc); sig(id, 'offer', p.pc.localDescription); } S.poll = setTimeout(loop, 1000); } catch { S.poll = setTimeout(reconnect, 3000); } }

async function enter(room, name, create) {
  if (!supported()) return err('UNSUPPORTED BROWSER', 'Please use an updated Chrome, Firefox, Edge or Safari.');
  S.room = room; S.me = name; S.id = rid(12); S.peers = {}; S.fails = 0; S.last = Date.now(); S.owner = !!create; S.endsAt = create ? Date.now() + v2.rl : 0; ls.set('ghostroom_nickname', name);
  show('chat'); $('#rc').textContent = room; $('#log').textContent = ''; $('#qrchat').textContent = '';
  const boot = ['initializing ghostroom...', 'establishing signaling channel...', 'waiting for peer...']; S.msgs = []; boot.forEach(t => S.msgs.push({ sys: true, text: '> ' + t })); render();
  try {
    try { ICE = (await api('ice', {}, true)).iceServers || ICE; } catch {}
    if (create) await api('create', { ttl: S.ttl });
    const j = await api('join'); S.ttl = j.ttl; S.on = true;
    S.msgs = ls.get('ghostroom_messages', []).filter(m => m.room === room); cleanupExpiredMessages();
    sys('You joined the room.');
    for (const id of j.peers) { const p = mk(id, true); const o = await p.pc.createOffer(); await p.pc.setLocalDescription(o); await gathered(p.pc); sig(id, 'offer', p.pc.localDescription); }
    ls.set('ghostroom_active_room', room); loop(); stat();
  } catch (e) {
    if (e.status === 404) err('ROOM NOT FOUND', 'The room may have expired or the room code is invalid.');
    else if (e.status === 429) err('ROOM FULL', 'This room has reached its user limit.');
    else err('CONNECTION FAILED', 'Possible causes: network restrictions, browser restrictions, NAT/firewall, signaling unavailable.', () => enter(room, name, create));
  }
}
function leave() { S.on = false; clearTimeout(S.poll); Object.keys(S.peers).forEach(k => drop(k)); api('leave').catch(() => {}); S.msgs = []; ls.set('ghostroom_messages', []); ls.set('ghostroom_active_room', ''); history.replaceState(null, '', '/'); show('landing'); }

function sendMsg() {
  const el = $('#in'), text = el.value.replace(/\s+$/, '');
  if (!text) return; if (v2.cmd(text)) { el.value = ''; return; } const n = Date.now(); S.rate = S.rate.filter(t => n - t < 5000);
  if (S.rate.length >= 5) { $('#typing').textContent = '> rate limit: slow down'; return; } S.rate.push(n);
  const now = Date.now(), m = { t: 'm', id: rid(10), text: text.slice(0, 2000), burn: v2.burn() ? 1 : 0 }; S.last = now;
  for (const p of Object.values(S.peers)) if (p.dc?.readyState === 'open') p.dc.send(JSON.stringify(m));
  addMsg({ id: m.id, room: S.room, sender: S.me, mine: true, text: m.text, createdAt: now, expiresAt: now + S.ttl }); el.value = ''; el.style.height = 'auto';
}
async function qr(box) {
  if (box.firstChild) return box.textContent = '';
  try {
    if (!window.qrcode) await new Promise((ok, no) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js'; s.onload = ok; s.onerror = no; document.head.append(s); });
    const q = qrcode(0, 'M'); q.addData(link()); q.make(); box.innerHTML = q.createSvgTag(5); // library-generated SVG, no user text
  } catch { box.textContent = 'QR library failed to load (offline?)'; }
}

// ---- UI wiring ----
$('#ttls').innerHTML = ''; TTLS.forEach(([l, v]) => { const b = document.createElement('button'); b.textContent = l; b.className = v === ttlSel ? 'sel' : ''; b.onclick = () => { ttlSel = v; $$('#ttls button').forEach(x => x.className = ''); b.className = 'sel'; }; $('#ttls').append(b); });
$$('[data-go]').forEach(b => b.onclick = () => { if (b.dataset.go === 'create') { $('#made').hidden = true; $('#qrbox').textContent = ''; } show(b.dataset.go); });
$('#cn').value = $('#jn').value = ls.get('ghostroom_nickname', '');
$('#gen').onclick = () => {
  const n = clean($('#cn').value, 20); if (!n) return flash($('#cmsg'), '> codename required');
  S.room = rid(6); S.ttl = ttlSel; S.me = n; $('#mcode').textContent = S.room; $('#mlink').textContent = link(); $('#made').hidden = false; $('#gen').hidden = true;
};
$('#cc').onclick = async () => { await copy(S.room); flash($('#cmsg'), '> COPIED TO CLIPBOARD'); };
$('#cl').onclick = async () => { await copy(link()); flash($('#cmsg'), '> COPIED TO CLIPBOARD'); };
$('#wa').onclick = () => window.open('https://wa.me/?text=' + encodeURIComponent(`👻 GhostRoom\n\nJoin my temporary chat room:\n\n${link()}\n\nRoom Code: ${S.room}`), '_blank', 'noopener');
$('#qr').onclick = () => qr($('#qrbox')); $('#shareb').onclick = () => qr($('#qrchat'));
$('#enter').onclick = () => { $('#gen').hidden = false; enter(S.room, S.me, true); };
$('#connect').onclick = () => {
  const r = clean($('#jc').value, 12).toUpperCase(), n = clean($('#jn').value, 20);
  if (!/^[A-HJ-NP-Z2-9]{6,12}$/.test(r)) return flash($('#jmsg'), '> invalid room code'); if (!n) return flash($('#jmsg'), '> codename required'); enter(r, n, false);
};
$('#leave').onclick = leave; $('#eback').onclick = () => { S.on = false; show('landing'); }; $('#retry').onclick = () => S.retry && S.retry();
$('#send').onclick = sendMsg; $('#snd').onclick = () => { S.snd = !S.snd; $('#snd').textContent = `[SND:${S.snd ? 'ON' : 'OFF'}]`; };
$('#in').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && matchMedia('(hover:hover)').matches) { e.preventDefault(); sendMsg(); } });
let lt = 0; $('#in').addEventListener('input', e => { e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; if (Date.now() - lt > 1500) { lt = Date.now(); for (const p of Object.values(S.peers)) if (p.dc?.readyState === 'open') p.dc.send('{"t":"ty"}'); } });
addEventListener('pagehide', () => { if (S.on) navigator.sendBeacon?.('/api/signal', new Blob([JSON.stringify({ action: 'leave', room: S.room, peer: S.id })], { type: 'application/json' })); });
const qroom = clean(new URLSearchParams(location.search).get('room'), 12).toUpperCase();
if (qroom) { $('#jc').value = qroom; show('join'); }
if (!supported()) err('UNSUPPORTED BROWSER', 'Please use an updated Chrome, Firefox, Edge or Safari.');
S.msgs = ls.get('ghostroom_messages', []); cleanupExpiredMessages(); setInterval(() => { cleanupExpiredMessages(); if (S.on) stat(); }, 1000);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js').catch(() => {});
