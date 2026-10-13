'use strict';

/*
  Hub de sinalização.

  Tudo que antes era "confiança no cliente" é decidido aqui:
    - entrar na sala exige senha / não estar trancada / não estar banido / ter vaga
    - quem é host é provado pelo token (não pelo que o cliente diz ser)
    - só host expulsa e libera/revoga transmissão
    - o payload de presença é montado pelo servidor (ninguém se declara "sharing" ou "host")
    - sinalização WebRTC é entregue só ao destinatário, com `from` carimbado pelo servidor
*/

const { acceptWebSocket } = require('./ws');
const { TokenBucket, verifySecret, isClientHash, CODE_RE } = require('./security');

const TOPIC_RE = /^rise-(RISE-[A-HJ-NP-Z2-9]{6})$/i;
const UID_RE = /^[A-Za-z0-9-]{8,64}$/;
const SIGNAL_TYPES = new Set(['stream-request', 'stream-available', 'stream-stopped', 'offer', 'answer', 'ice']);
const MAX_SIGNAL_BYTES = 48 * 1024;

const cleanName = v => {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 28);
  return s || 'Convidado';
};

class Hub {
  constructor({ store, limiter, config }) {
    this.store = store;
    this.limiter = limiter;
    this.cfg = config;
    this.rooms = new Map();      // code -> { code, members: Map<uid, Member> }
    this.clients = new Set();    // todas as conexões abertas
    this.perIp = new Map();      // ip -> nº de conexões

    this.keepalive = setInterval(() => this._keepalive(), 25_000);
    this.keepalive.unref();
  }

  get socketCount() { return this.clients.size; }

  /* ------------------------------------------------------------------ */
  /* upgrade                                                             */
  /* ------------------------------------------------------------------ */

  _originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // cliente que não é navegador: ainda precisa de credenciais
    try {
      if (new URL(origin).host === req.headers.host) return true;
    } catch { return false; }
    return this.cfg.allowedOrigins.includes(origin);
  }

  handleUpgrade(req, socket, ip) {
    const reject = (status, text) => {
      try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* ignora */ }
      socket.destroy();
    };

    if (!this._originAllowed(req)) return reject(403, 'Forbidden');
    const n = this.perIp.get(ip) || 0;
    if (n >= this.cfg.maxConnPerIp) return reject(429, 'Too Many Requests');

    const client = { conn: null, ip, member: null, authing: false, strikes: 0, bucket: new TokenBucket(100, 50) };
    const conn = acceptWebSocket(req, socket, {
      maxPayload: 64 * 1024,
      onMessage: text => this._onMessage(client, text),
      onClose: () => this._onClose(client)
    });
    if (!conn) return;
    client.conn = conn;
    client.born = Date.now();
    this.clients.add(client);
    this.perIp.set(ip, n + 1);
  }

  _onClose(client) {
    this.clients.delete(client);
    const n = (this.perIp.get(client.ip) || 1) - 1;
    if (n <= 0) this.perIp.delete(client.ip); else this.perIp.set(client.ip, n);
    if (client.member) this._leave(client.member, client);
  }

  _keepalive() {
    const now = Date.now();
    for (const c of this.clients) {
      if (!c.member && now - c.born > 10_000) { c.conn.terminate(); continue; } // nunca se identificou
      if (now - c.conn.lastSeen > 70_000) { c.conn.terminate(); continue; }    // morto
      c.conn.ping();
    }
  }

  /* ------------------------------------------------------------------ */
  /* mensagens                                                           */
  /* ------------------------------------------------------------------ */

  _onMessage(client, text) {
    if (!client.bucket.take()) {
      if (++client.strikes > 300) client.conn.close(1008, 'flood');
      return;
    }
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.op === 'hello') {
      if (client.member || client.authing) return;
      client.authing = true;
      this._hello(client, msg)
        .catch(e => { console.error('[rise] hello:', e.message); client.conn.close(1011, 'error'); })
        .finally(() => { client.authing = false; });
      return;
    }

    const m = client.member;
    if (!m) return;

    if (msg.op === 'track') return this._track(m, msg);
    if (msg.op === 'bc') {
      if (msg.event === 'signal') return this._signal(m, msg.payload);
      if (msg.event === 'control') return this._control(m, msg.payload);
    }
  }

  _deny(client, reason) {
    client.conn.send({ op: 'denied', reason });
    client.conn.close(4001, reason);
  }

  async _hello(client, msg) {
    const topic = TOPIC_RE.exec(String(msg.topic || ''));
    const uid = String(msg.uid || '');
    if (!topic || !UID_RE.test(uid)) return this._deny(client, 'bad-request');
    const code = topic[1].toUpperCase();
    if (!CODE_RE.test(code)) return this._deny(client, 'bad-request');

    const room = this.store.live(code);
    if (!room) return this._deny(client, 'not-found');
    if (room.banned.includes(uid)) return this._deny(client, 'kicked');

    // quem tenta adivinhar senha/token paga caro: poucas tentativas por IP e sala
    const scale = this.cfg.rateScale;
    if (!this.limiter.hit(`auth:${client.ip}:${code}`, 40 * scale, 5 * 60_000)) return this._deny(client, 'rate');

    let isHost = false;
    if (isClientHash(msg.host_token_hash)) isHost = await verifySecret(msg.host_token_hash, room.host_secret);

    if (!isHost) {
      if (room.locked) return this._deny(client, 'locked');
      if (room.password_secret != null && !(await verifySecret(msg.password_hash, room.password_secret))) {
        return this._deny(client, 'password');
      }
    }

    // a sala pode ter sido encerrada/expirada enquanto o scrypt rodava
    if (!this.store.live(code)) return this._deny(client, 'not-found');

    let hubRoom = this.rooms.get(code);
    if (!hubRoom) { hubRoom = { code, members: new Map() }; this.rooms.set(code, hubRoom); }

    const old = hubRoom.members.get(uid);
    if (!isHost && !old && hubRoom.members.size >= this.cfg.maxParticipants) return this._deny(client, 'full');

    if (old) { // reconexão da mesma pessoa: a conexão antiga cai sem alarde
      hubRoom.members.delete(uid);
      old.conn.close(1000, 'replaced');
      if (old.client) old.client.member = null;
    }

    const member = {
      uid,
      code,
      client,
      conn: client.conn,
      name: cleanName(msg.name),
      isHost,
      joinedAt: new Date().toISOString(),
      entry: null
    };
    hubRoom.members.set(uid, member);
    client.member = member;

    client.conn.send({ op: 'ready', topic: `rise-${code}`, isHost, allowed: this._allowed(room, member) });
    client.conn.send({ op: 'sync', state: this._state(hubRoom) });
    this.store.addLog(code, member.name, 'ENTROU_NA_SALA', isHost ? 'host' : '');
  }

  _allowed(room, member) {
    return member.isHost || room.grants.includes(member.uid);
  }

  /** Monta o payload de presença; nada aqui vem do que o cliente afirma sobre si. */
  _track(m, msg) {
    const room = this.store.live(m.code);
    const hubRoom = this.rooms.get(m.code);
    if (!room || !hubRoom || hubRoom.members.get(m.uid) !== m) return;

    const p = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
    const allowed = this._allowed(room, m);
    const wasSharing = !!m.entry?.sharing;
    const first = m.entry == null;

    m.entry = {
      userId: m.uid,
      name: m.name,
      isHost: m.isHost,
      sharing: !!p.sharing && allowed,
      role: p.role === 'participant' ? 'participant' : 'spectator',
      shareAllowed: allowed,
      joinedAt: m.joinedAt
    };

    if (first) this._broadcast(hubRoom, m.uid, { op: 'join', news: [m.entry] });
    if (m.entry.sharing !== wasSharing) {
      this.store.addLog(m.code, m.name, m.entry.sharing ? 'TRANSMISSAO_INICIADA' : 'TRANSMISSAO_ENCERRADA');
    }
    this._sync(hubRoom);
    m.conn.send({ op: 'tracked', ref: msg.ref });
    this._refreshStatus(room, hubRoom);
  }

  _signal(m, p) {
    if (!p || typeof p !== 'object' || !SIGNAL_TYPES.has(p.type)) return;
    if (JSON.stringify(p.data ?? null).length > MAX_SIGNAL_BYTES) return;
    // só anuncia transmissão quem está transmitindo de fato
    if (p.type === 'stream-available' && !m.entry?.sharing) return;

    const hubRoom = this.rooms.get(m.code);
    if (!hubRoom) return;
    const to = typeof p.to === 'string' ? p.to : null;
    const out = { op: 'bc', event: 'signal', payload: { from: m.uid, to, type: p.type, data: p.data ?? {} } };

    if (to) hubRoom.members.get(to)?.conn.send(out);
    else this._broadcast(hubRoom, m.uid, out);
  }

  _control(m, p) {
    if (!p || typeof p !== 'object' || !m.isHost) return; // controle de sala é exclusivo do host
    const room = this.store.live(m.code);
    const hubRoom = this.rooms.get(m.code);
    if (!room || !hubRoom) return;

    const target = typeof p.to === 'string' ? hubRoom.members.get(p.to) : null;
    if (!target || target.isHost) return;

    if (p.type === 'kick') {
      if (!room.banned.includes(target.uid)) room.banned.push(target.uid);
      room.grants = room.grants.filter(u => u !== target.uid);
      this.store.save();
      this.store.addLog(m.code, m.name, 'EXPULSAO', target.name);
      this._toMember(target, 'kick', {});
      setTimeout(() => target.conn.close(4003, 'kicked'), 250);
      return;
    }

    if (p.type === 'share-permission') {
      const allowed = !!p.data?.allowed;
      const had = room.grants.includes(target.uid);
      if (allowed && !had) room.grants.push(target.uid);
      if (!allowed && had) room.grants = room.grants.filter(u => u !== target.uid);
      this.store.save();
      this.store.addLog(m.code, m.name, allowed ? 'PERMISSAO_TRANSMISSAO' : 'PERMISSAO_REVOGADA', target.name);

      if (target.entry) {
        target.entry = { ...target.entry, shareAllowed: allowed, sharing: allowed && target.entry.sharing };
        this._sync(hubRoom);
      }
      this._toMember(target, 'share-permission', { allowed });
      this._refreshStatus(room, hubRoom);
    }
  }

  /* ------------------------------------------------------------------ */
  /* presença                                                            */
  /* ------------------------------------------------------------------ */

  _state(hubRoom) {
    const state = {};
    for (const m of hubRoom.members.values()) if (m.entry) state[m.uid] = [m.entry];
    return state;
  }

  _sync(hubRoom) {
    const state = this._state(hubRoom);
    for (const m of hubRoom.members.values()) m.conn.send({ op: 'sync', state });
  }

  _broadcast(hubRoom, exceptUid, obj) {
    for (const m of hubRoom.members.values()) if (m.uid !== exceptUid) m.conn.send(obj);
  }

  _toMember(member, type, data) {
    member.conn.send({ op: 'bc', event: 'control', payload: { from: 'server', to: member.uid, type, data } });
  }

  _leave(member, client) {
    const hubRoom = this.rooms.get(member.code);
    if (!hubRoom || hubRoom.members.get(member.uid) !== member) return;
    hubRoom.members.delete(member.uid);

    this.store.addLog(member.code, member.name, 'SAIU_DA_SALA');
    if (member.entry) {
      if (member.entry.sharing) this.store.addLog(member.code, member.name, 'TRANSMISSAO_ENCERRADA');
      this._broadcast(hubRoom, member.uid, { op: 'leave', lefts: [member.entry] });
    }
    if (client) client.member = null;

    if (hubRoom.members.size === 0) this.rooms.delete(member.code);
    else this._sync(hubRoom);

    const room = this.store.live(member.code);
    if (room) this._refreshStatus(room, hubRoom);
  }

  /** O status ("live" / "waiting") é derivado de quem está transmitindo; ninguém o escolhe. */
  _refreshStatus(room, hubRoom) {
    if (room.closed) return;
    const live = [...hubRoom.members.values()].some(m => m.entry?.sharing);
    const next = live ? 'live' : 'waiting';
    if (room.status === next) return;
    room.status = next;
    this.store.save();
    this.roomUpdated(room.code);
  }

  /* ------------------------------------------------------------------ */
  /* chamado pelo HTTP (ações do host) e pela expiração                  */
  /* ------------------------------------------------------------------ */

  roomUpdated(code) {
    const room = this.store.rooms[code];
    const hubRoom = this.rooms.get(code);
    if (!room || !hubRoom) return;
    const data = { title: room.title, locked: room.locked, status: room.status };
    for (const m of hubRoom.members.values()) this._toMember(m, 'room-state', data);
  }

  closeRoom(code, notify = true) {
    const hubRoom = this.rooms.get(code);
    if (!hubRoom) return;
    this.rooms.delete(code);
    for (const m of hubRoom.members.values()) {
      if (notify) this._toMember(m, 'room-closed', {});
      m.client.member = null; // evita log de "saiu" depois de a sala já ter acabado
      setTimeout(() => m.conn.close(1000, 'room-closed'), 250);
    }
  }

  shutdown() {
    clearInterval(this.keepalive);
    for (const c of this.clients) c.conn.close(1001, 'shutdown');
  }
}

module.exports = { Hub };
