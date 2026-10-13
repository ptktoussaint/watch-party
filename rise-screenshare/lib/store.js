'use strict';

/*
  Armazenamento em arquivo JSON (salas + logs).
  Gravação atômica (tmp + rename) e com debounce; suficiente para uma instância.
*/

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const MAX_LOGS = 5000;
const MAX_LOGS_PER_ROOM = 300;

class Store {
  constructor(file, { ttlHours = 3, maxRooms = 500 } = {}) {
    this.file = file;
    this.ttlMs = ttlHours * 3600e3;
    this.maxRooms = maxRooms;
    this.rooms = {};
    this.logs = [];
    this.seq = 0;
    this.writable = true;
    this.onRoomRemoved = null;

    this._timer = null;
    this._saving = null;
    this._closed = false;
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.rooms = parsed.rooms && typeof parsed.rooms === 'object' ? parsed.rooms : {};
      this.logs = Array.isArray(parsed.logs) ? parsed.logs : [];
      this.seq = Number(parsed.seq) || 0;
      for (const room of Object.values(this.rooms)) {
        room.grants = Array.isArray(room.grants) ? room.grants : [];
        room.banned = Array.isArray(room.banned) ? room.banned : [];
      }
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn('[rise] data.json ilegível, começando vazio:', e.message);
      this.rooms = {};
      this.logs = [];
      this.seq = 0;
    }
    this._probeWritable();
  }

  _probeWritable() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const probe = this.file + '.write-test';
      fs.writeFileSync(probe, 'ok', 'utf8');
      fs.unlinkSync(probe);
      this.writable = true;
    } catch (e) {
      this.writable = false;
      console.error('[rise] AVISO: sem permissão de escrita em', path.dirname(this.file), '—', e.message);
      console.error('[rise] as salas não serão salvas.');
    }
  }

  save() {
    if (this._timer || this._closed) return;
    this._timer = setTimeout(() => { this._timer = null; this.flush(); }, 150);
  }

  /** Última gravação: depois disso, nada mais é agendado. */
  async close() {
    await this.flush();
    this._closed = true;
  }

  /** Grava agora; se já houver uma gravação em andamento, espera e grava de novo. */
  async flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    while (this._saving) await this._saving;
    if (!this.writable) return;
    const tmp = this.file + '.tmp';
    this._saving = (async () => {
      try {
        const snapshot = JSON.stringify({ rooms: this.rooms, logs: this.logs, seq: this.seq });
        await fsp.writeFile(tmp, snapshot, { encoding: 'utf8', mode: 0o600 });
        await fsp.rename(tmp, this.file);
      } catch (e) {
        console.error('[rise] falha ao gravar data.json:', e.message);
        try { await fsp.unlink(tmp); } catch { /* ignora */ }
      }
    })();
    await this._saving;
    this._saving = null;
  }

  /** Remove salas vencidas (e os logs delas). Devolve os códigos removidos. */
  purge() {
    const now = Date.now();
    const removed = [];
    for (const [code, room] of Object.entries(this.rooms)) {
      if (new Date(room.expires_at).getTime() <= now) {
        delete this.rooms[code];
        removed.push(code);
      }
    }
    if (removed.length) {
      const alive = new Set(Object.keys(this.rooms));
      this.logs = this.logs.filter(l => alive.has(l.room_code));
      this.save();
      if (this.onRoomRemoved) for (const code of removed) this.onRoomRemoved(code);
    }
    return removed;
  }

  /** Sala viva = existe, não foi encerrada e está dentro da validade. */
  live(code) {
    const room = this.rooms[code];
    if (!room || room.closed) return null;
    if (new Date(room.expires_at).getTime() <= Date.now()) return null;
    return room;
  }

  /** A validade é decidida aqui; nunca pelo cliente. */
  create({ code, title, hostName, hostSecret, passwordSecret }) {
    this.purge();
    if (this.rooms[code]) return false;
    if (Object.keys(this.rooms).length >= this.maxRooms) return false;
    this.rooms[code] = {
      code,
      title,
      host_name: hostName,
      host_secret: hostSecret,
      password_secret: passwordSecret,
      status: 'waiting',
      locked: false,
      closed: false,
      grants: [],
      banned: [],
      expires_at: new Date(Date.now() + this.ttlMs).toISOString(),
      created_at: new Date().toISOString()
    };
    this.save();
    return true;
  }

  publicView(room) {
    return {
      code: room.code,
      title: room.title,
      host_name: room.host_name,
      status: room.status,
      locked: room.locked,
      closed: room.closed,
      password_required: room.password_secret != null,
      expires_at: room.expires_at
    };
  }

  addLog(roomCode, actorName, eventType, details = null) {
    if (!this.rooms[roomCode]) return;
    this.logs.push({
      id: ++this.seq,
      room_code: roomCode,
      actor_name: String(actorName || 'Sistema').slice(0, 80),
      event_type: String(eventType || '').slice(0, 60),
      details: details == null ? null : String(details).slice(0, 300),
      created_at: new Date().toISOString()
    });
    // limite por sala (descarta o mais antigo daquela sala) e limite global
    let count = 0;
    for (let i = this.logs.length - 1; i >= 0; i--) {
      if (this.logs[i].room_code === roomCode && ++count > MAX_LOGS_PER_ROOM) { this.logs.splice(i, 1); break; }
    }
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
    this.save();
  }

  logsFor(roomCode, limit = 80) {
    return this.logs
      .filter(l => l.room_code === roomCode)
      .sort((a, b) => b.id - a.id)
      .slice(0, Math.min(Number(limit) || 80, 200));
  }
}

module.exports = { Store };
