'use strict';
// GhostRoom V2 layer: commands, burn, files/voice (chunked over DataChannel), polls, room self-destruct. Loaded after app.js (shares its globals).
const LIM = { FILE: 10 * 1048576, CHUNK: 12288, VOICE: 60, POLLQ: 200, POLLO: 100, TTLS: [1e4, 6e4, 3e5, 36e5, 864e5] }; // easy-to-change constants
const RLS = [['10m', 6e5], ['30m', 18e5], ['1h', 36e5], ['6h', 216e5], ['24h', 864e5]];
const out = {}, inn = {}, pgs = {}; let rec = null, vb, burnBox;
const open_ = () => Object.values(S.peers).filter(p => p.dc && p.dc.readyState === 'open');
const bc = o => { const s = JSON.stringify(o); open_().forEach(p => p.dc.send(s)); };
const el = (t, x, c) => { const e = document.createElement(t); if (x) e.textContent = x; if (c) e.className = c; return e; };
const fmt = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.ceil(n / 1024) + ' KB';
const cd = ms => { ms = Math.max(0, ms / 1000 | 0); return pad(ms / 60 | 0) + ':' + pad(ms % 60); };
const b64 = b => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result.split(',')[1]); f.readAsDataURL(b); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lbl = m => { const s = el('span', '', 'dim'); s.dataset.x = m.expiresAt; s.textContent = '🔥 expires in ' + cd(m.expiresAt - Date.now()); return s; };
const safeImg = /^image\/(png|jpe?g|gif|webp)$/, safeAud = /^audio\/(webm|ogg|mp4|mpeg|wav)$/;
const exp = (m, ms) => { m.expiresAt = Date.now() + ms; render(); };

const v2 = {
  rl: 36e5, burn: () => !!(burnBox && burnBox.checked),
  rx(p, d) {
    const t = d.t;
    if (t === 'm' && d.burn && typeof d.text === 'string' && d.text.length <= 2000) { const n = Date.now(); addMsg({ kind: 'burn', room: S.room, sender: p.name, text: d.text, createdAt: n, expiresAt: n + S.ttl, state: 'closed' }); return true; }
    if (t === 'pg') { p.dc.send(JSON.stringify({ t: 'po', ts: d.ts })); return true; }
    if (t === 'po') { if (pgs.on) sys(`${p.name}  ${Date.now() - d.ts}ms`); return true; }
    if (t === 'tm') { if (LIM.TTLS.includes(d.ttl)) { S.ttl = d.ttl; sys(`> ${p.name} set TTL to ${cd(d.ttl)}`); } return true; }
    if (t === 'burn') { if (p.own) v2.destroy(); return true; }
    if (t === 'poll') { const n = Date.now(), q = clean(d.q, LIM.POLLQ), o = Array.isArray(d.o) ? d.o.slice(0, 6).map(x => clean(x, LIM.POLLO)).filter(Boolean) : []; if (q && o.length > 1 && /^\w{4,12}$/.test(d.pid)) addMsg({ kind: 'poll', pid: d.pid, q, opts: o, votes: {}, sender: p.name, createdAt: n, expiresAt: n + S.ttl }); return true; }
    if (t === 'vote') { const m = S.msgs.find(x => x.pid === d.pid && x.kind === 'poll'); if (m && !(p.id in m.votes) && Number.isInteger(d.i) && d.i >= 0 && d.i < m.opts.length) { m.votes[p.id] = d.i; render(); } return true; }
    if (t === 'fo') {
      const size = +d.size, id = String(d.id || ''); if (!/^\w{4,12}$/.test(id) || !(size > 0) || size > LIM.FILE) return true;
      const n = Date.now(), m = { kind: 'file', fid: id, from: p.id, sender: p.name, name: clean(d.name, 100).replace(/[\\/]/g, '_') || 'file', size, mime: clean(d.mime, 60), voice: d.voice ? 1 : 0, burn: d.burn ? 1 : 0, state: 'offer', got: 0, createdAt: n, expiresAt: n + S.ttl };
      addMsg(m); if (m.voice && size < 4e6) v2.accept(m); return true;
    }
    if (t === 'fa') { v2.stream(p, String(d.id)); return true; }
    if (t === 'fr') { const o = out[d.id]; if (o) o.rej = o.rej || {}, o.rej[p.id] = 1; return true; }
    if (t === 'fc') { const r = inn[d.id]; if (r && r.from === p.id && d.i === r.parts.length && typeof d.d === 'string' && d.d.length <= 17000) { r.parts.push(d.d); r.m.got = Math.min(r.m.size, r.parts.length * LIM.CHUNK); r.t = Date.now(); if (r.parts.length > Math.ceil(r.m.size / LIM.CHUNK)) v2.fail(r.m); else if (d.i % 8 == 0) render(); } return true; }
    if (t === 'fe') { const r = inn[d.id]; if (!r || r.from !== p.id) return true; delete inn[d.id]; const m = r.m;
      if (r.parts.length !== Math.ceil(m.size / LIM.CHUNK)) return v2.fail(m), true;
      try { const u8 = r.parts.map(s => Uint8Array.from(atob(s), c => c.charCodeAt(0))); const b = new Blob(u8, { type: m.mime }); if (b.size !== m.size) throw 0; m.url = URL.createObjectURL(b); m.state = 'done'; m.expiresAt = Date.now() + S.ttl; render(); } catch { v2.fail(m); } return true; }
    if (t === 'fx') { const r = inn[d.id]; if (r && r.from === p.id) v2.fail(r.m); return true; }
    return false;
  },
  fail(m) { delete inn[m.fid]; m.state = 'fail'; m.expiresAt = Date.now() + 15000; render(); },
  accept(m) { m.state = 'recv'; inn[m.fid] = { parts: [], m, from: m.from, t: Date.now() }; S.peers[m.from]?.dc.send(JSON.stringify({ t: 'fa', id: m.fid })); render(); },
  reject(m) { m.state = 'rej'; m.expiresAt = Date.now() + 10000; S.peers[m.from]?.dc.send(JSON.stringify({ t: 'fr', id: m.fid })); render(); },
  async stream(p, id) {
    const o = out[id]; if (!o || !p.dc) return;
    try {
      for (let i = 0; i * LIM.CHUNK < o.f.size; i++) {
        if (!out[id] || p.dc.readyState !== 'open') return; while (p.dc.bufferedAmount > 262144) await sleep(25);
        p.dc.send(JSON.stringify({ t: 'fc', id, i, d: await b64(o.f.slice(i * LIM.CHUNK, (i + 1) * LIM.CHUNK)) }));
      } p.dc.send(JSON.stringify({ t: 'fe', id }));
    } catch { try { p.dc.send(JSON.stringify({ t: 'fx', id })); } catch {} }
  },
  send(f, voice) {
    if (!open_().length) return sys('> no peers connected yet');
    if (f.size > LIM.FILE || !f.size) return sys(`> FILE REJECTED: max ${fmt(LIM.FILE)}`);
    const id = rid(8), n = Date.now(), b = v2.burn() ? 1 : 0, name = clean(f.name, 100).replace(/[\\/]/g, '_') || 'file'; out[id] = { f };
    bc({ t: 'fo', id, name, size: f.size, mime: f.type, voice: voice ? 1 : 0, burn: b });
    addMsg({ kind: 'file', fid: id, own: 1, sender: S.me, name, size: f.size, mime: f.type, voice: voice ? 1 : 0, burn: b, state: 'done', url: URL.createObjectURL(f), createdAt: n, expiresAt: n + S.ttl });
  },
  async voice() {
    if (rec) return rec.stop();
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true }), ch = []; rec = new MediaRecorder(s); const r = rec;
      r.ondataavailable = e => ch.push(e.data);
      r.onstop = () => { s.getTracks().forEach(t => t.stop()); clearTimeout(r.to); rec = null; vb.textContent = '🎙 VOICE'; const b = new Blob(ch, { type: r.mimeType || 'audio/webm' }); if (b.size) v2.send(new File([b], 'voice.webm', { type: b.type.split(';')[0] }), 1); };
      r.start(); r.to = setTimeout(() => r.state === 'recording' && r.stop(), LIM.VOICE * 1e3); vb.textContent = '■ STOP & SEND';
    } catch { sys('> MICROPHONE ACCESS DENIED\nPlease allow microphone access to send voice messages.'); }
  },
  poll(q) {
    q = clean(q || prompt('POLL QUESTION'), LIM.POLLQ); if (!q) return;
    const o = clean(prompt('OPTIONS (separate with |, 2-6)') || '', 700).split('|').map(x => clean(x, LIM.POLLO)).filter(Boolean).slice(0, 6); if (o.length < 2) return sys('> poll needs 2+ options');
    const pid = rid(8), n = Date.now(); bc({ t: 'poll', pid, q, o }); addMsg({ kind: 'poll', pid, q, opts: o, votes: {}, sender: S.me, createdAt: n, expiresAt: n + S.ttl });
  },
  vote(m, i) { if (S.id in m.votes) return; m.votes[S.id] = i; bc({ t: 'vote', pid: m.pid, i }); render(); },
  secret() { const t = clean(prompt('SECRET MESSAGE (one-time open, 2000 max)') || '', 2000); if (!t) return; const n = Date.now(); bc({ t: 'm', id: rid(10), text: t, burn: 1 }); sys('> SECRET DROP SENT (opens once per recipient)'); },
  destroy(manual) {
    if (manual && S.owner) bc({ t: 'burn' }); S.msgs.forEach(m => m.url && URL.revokeObjectURL(m.url)); for (const k in out) delete out[k]; for (const k in inn) delete inn[k]; if (rec) rec.stop();
    leave(); err('ROOM DESTROYED', 'The temporary room has expired or was destroyed. All local room data has been cleared.');
  },
  cmd(text) {
    if (text[0] !== '/') return false; const [c, a] = text.slice(1).trim().split(/\s+/), n = open_(), names = [S.me, ...n.map(p => p.name)];
    const H = { help: () => sys('> GHOSTROOM COMMANDS\n/help /clear /users /info /timer 5m /burn /poll /invite /qr /ping /leave'),
      clear: () => { S.msgs = []; sys('> LOCAL CHAT CLEARED (remote copies are not affected)'); },
      users: () => sys('> ACTIVE PEERS\n' + names.map((x, i) => pad(i + 1) + '  ' + x).join('\n') + '\nTOTAL: ' + names.length),
      info: () => sys(`> ROOM INFORMATION\nROOM ID     : ${S.room}\nSTATUS      : ACTIVE\nUSERS       : ${names.length}\nMESSAGE TTL : ${cd(S.ttl)}\nP2P STATUS  : ${n.length ? 'CONNECTED' : 'WAITING'}\nSELF-DESTRUCT: ${S.endsAt ? cd(S.endsAt - Date.now()) : '?'}`),
      timer: () => { const m = /^(\d+)(s|m|h)$/.exec(a || ''), v = m && +m[1] * { s: 1e3, m: 6e4, h: 36e5 }[m[2]]; if (!LIM.TTLS.includes(v)) return sys('> usage: /timer 10s|1m|5m|1h|24h'); S.ttl = v; bc({ t: 'tm', ttl: v }); sys('> MESSAGE TTL SET: ' + a); },
      burn: () => { if (!S.owner) return sys('> only the room owner can destroy the room'); if (confirm('Destroy this room? All connected users will be disconnected.')) v2.destroy(true); },
      poll: () => v2.poll(), invite: () => { copy(link()); sys(`> INVITE (copied)\n${link()}\nCode: ${S.room}`); }, qr: () => qr($('#qrchat')),
      ping: () => { if (!n.length) return sys('> no peers'); pgs.on = 1; bc({ t: 'pg', ts: Date.now() }); sys('> PING'); setTimeout(() => pgs.on = 0, 3000); }, leave };
    (H[c] || (() => sys('> unknown command. try /help')))(); return true;
  },
  node(m) {
    const d = el('div', 'm' + (m.own ? ' me' : '')); d.append(el('small', `[${hm(m.createdAt)}] ${m.sender}`));
    if (m.kind === 'burn') {
      if (m.state === 'closed') { const b = el('button', '🔐 SECRET MESSAGE — [ OPEN ]'); b.onclick = () => { m.state = 'open'; exp(m, 6000); }; d.append(b, el('div', '🔥 BURN AFTER READING', 'dim')); }
      else d.append(el('div', '> ' + m.text), el('div', '> SELF-DESTRUCTING...', 'sys'));
    } else if (m.kind === 'poll') {
      d.append(el('b', '📊 ' + m.q)); const tot = Object.keys(m.votes).length;
      m.opts.forEach((o, i) => { const c = Object.values(m.votes).filter(v => v === i).length, b = el('button', `[ ${i + 1} ] ${o}  (${c})`); b.disabled = S.id in m.votes; b.onclick = () => v2.vote(m, i); d.append(el('div'), b); }); d.append(el('div', 'Votes: ' + tot, 'dim'));
    } else {
      d.append(el('div', (m.voice ? '🎙 VOICE MESSAGE ' : '📎 ') + (m.voice ? '' : m.name) + ` (${fmt(m.size)})`));
      if (m.state === 'offer') { const a = el('button', '[ ACCEPT ]'), r = el('button', '[ REJECT ]'); a.onclick = () => v2.accept(m); r.onclick = () => v2.reject(m); d.append(el('div', '> INCOMING FILE'), a, r); }
      else if (m.state === 'recv') d.append(el('div', '█'.repeat(Math.floor(m.got / m.size * 16)).padEnd(16, '░') + ` ${Math.floor(m.got / m.size * 100)}%`));
      else if (m.state === 'fail' || m.state === 'rej') d.append(el('div', m.state === 'rej' ? '> REJECTED' : '> TRANSFER FAILED', 'danger'));
      else if (m.url) {
        const onOpen = () => m.burn && !m.own && !m.opened && (m.opened = 1, setTimeout(() => exp(m, 0), 8000));
        if (safeImg.test(m.mime)) { const i = el('img'); i.src = m.url; i.alt = m.name; i.style.cssText = 'max-width:100%;max-height:260px;display:block;cursor:pointer'; i.onclick = onOpen; onOpen(); d.append(i); }
        else if (safeAud.test(m.mime)) { const a = el('audio'); a.controls = true; a.src = m.url; a.onplay = onOpen; d.append(a); }
        else { const o = el('a', '[ OPEN ]'), s = el('a', ' [ SAVE ]'); o.href = s.href = m.url; o.target = '_blank'; o.rel = 'noopener'; s.download = m.name; o.onclick = onOpen; d.append(o, s); }
        if (m.burn) d.append(el('div', '🔥 BURN AFTER VIEW', 'dim'));
      }
    }
    if (m.expiresAt) d.append(lbl(m)); return d;
  }
};
// wrappers
const _clean = cleanupExpiredMessages;
cleanupExpiredMessages = function () { const n = Date.now(); let gone = 0; S.msgs.forEach(m => { if (m.kind && m.expiresAt <= n) { gone++; if (m.url) URL.revokeObjectURL(m.url); delete out[m.fid]; delete inn[m.fid]; } }); _clean(); if (gone) sys('> CONTENT DESTROYED'); for (const k in inn) if (Date.now() - inn[k].t > 30000) v2.fail(inn[k].m); };
const _stat = stat;
stat = function () { _stat(); if (S.on) $('#info').textContent += ` | SIG: ${S.fails > 5 ? 'OFFLINE' : 'ONLINE'} | ROOM: ${S.endsAt ? cd(S.endsAt - Date.now()) : '--'}`; };
setInterval(() => { if (S.on && S.endsAt && Date.now() > S.endsAt) v2.destroy(); document.querySelectorAll('[data-x]').forEach(e => e.textContent = '🔥 expires in ' + cd(+e.dataset.x - Date.now())); }, 1000);
// UI injection
{
  const rl = el('div', '', 'row'); RLS.forEach(([l, v]) => { const b = el('button', l, v === v2.rl ? 'sel' : ''); b.onclick = () => { v2.rl = v; [...rl.children].forEach(x => x.className = ''); b.className = 'sel'; }; rl.append(b); });
  const g = $('#gen'); g.parentNode.parentNode.insertBefore(el('label', 'ROOM SELF-DESTRUCT'), g.parentNode); g.parentNode.parentNode.insertBefore(rl, g.parentNode);
  const bar = $('.bar'), plus = el('button', '[+]'), fi = el('input'), menu = el('div', '', 'box'); plus.setAttribute('aria-label', 'Attach'); fi.type = 'file'; fi.hidden = true; fi.accept = 'image/*,.pdf,.txt,.zip,.doc,.docx'; menu.hidden = true; menu.style.cssText = 'position:absolute;bottom:64px;left:8px;z-index:5';
  burnBox = el('input'); burnBox.type = 'checkbox'; const bl = el('label', '🔥 BURN'); bl.append(burnBox); bl.style.cssText = 'margin:0'; vb = el('button', '🎙 VOICE');
  const it = (t, f) => { const b = el('button', t); b.style.display = 'block'; b.onclick = () => { menu.hidden = true; f(); }; menu.append(b); return b; };
  it('📷 IMAGE', () => { fi.accept = 'image/*'; fi.click(); }); it('📎 FILE', () => { fi.accept = '.pdf,.txt,.zip,.doc,.docx,image/*'; fi.click(); });
  vb.style.display = 'block'; vb.onclick = () => { menu.hidden = true; v2.voice(); }; menu.append(vb);
  it('🔐 SECRET DROP', v2.secret); it('📊 POLL', () => v2.poll()); it('🔥 DESTROY ROOM', () => v2.cmd('/burn')); menu.append(bl);
  fi.onchange = () => { if (fi.files[0]) v2.send(fi.files[0]); fi.value = ''; }; plus.onclick = () => menu.hidden = !menu.hidden;
  bar.prepend(plus); bar.append(fi); $('#chat').append(menu); $('#chat').style.position = 'relative';
}
