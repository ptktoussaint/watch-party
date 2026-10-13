/* =============================================================
   Cliente de rede do Rise.

     RPC       → HTTP  POST /api/rpc/<nome>
     Presença  → WebSocket /ws (quem está na sala; o servidor monta o payload)
     Sinais    → WebSocket /ws (offer / answer / ICE entregues só ao destinatário)

   A mídia nunca passa pelo servidor: continua ponto a ponto.
   ============================================================= */

const baseUrl = () => location.origin;

const wsUrl = () => baseUrl().replace(/^http/, 'ws') + '/ws';

async function parseJson(res) {
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch {
    throw new Error(res.ok ? 'Resposta inválida do servidor' : `HTTP ${res.status}`);
  }
  if (!res.ok) {
    const msg = body?.error?.message || body?.error || `HTTP ${res.status}`;
    return { data: null, error: { message: String(msg), code: body?.error?.code || 'HTTP_' + res.status } };
  }
  return body;
}

/** Canal de presença + broadcast sobre um WebSocket. */
export class Channel {
  constructor(topic, auth) {
    this.topic = topic;
    this.auth = auth || {};       // { uid, name, host_token_hash?, password_hash? }
    this.ws = null;
    this.state = {};
    this.info = { isHost: false, allowed: false };
    this.closed = false;
    this.subscribed = false;
    this._statusCb = null;
    this._presence = { sync: [], join: [], leave: [] };
    this._broadcast = new Map();
    this._lastTrack = null;
    this._queue = [];
  }

  /** ch.on('presence', {event}, cb) | ch.on('broadcast', {event}, cb) */
  on(kind, opts, cb) {
    const event = opts?.event || '';
    if (kind === 'presence') this._presence[event]?.push(cb);
    else if (kind === 'broadcast') {
      if (!this._broadcast.has(event)) this._broadcast.set(event, []);
      this._broadcast.get(event).push(cb);
    }
    return this;
  }

  presenceState() { return this.state; }

  subscribe(statusCb) {
    this._statusCb = statusCb;
    this._connect();
    return this;
  }

  _status(st, err) {
    if (typeof this._statusCb !== 'function') return;
    try { this._statusCb(st, err); } catch (e) { console.warn('[rise] status cb', e); }
  }

  _emit(list, arg) {
    for (const cb of list || []) {
      try { cb(arg); } catch (e) { console.warn('[rise]', e); }
    }
  }

  _connect() {
    if (this.closed) return;
    let ws;
    try { ws = new WebSocket(wsUrl()); } catch (e) { this._status('CHANNEL_ERROR', e); return; }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) { try { ws.close(); } catch { /* ignora */ } return; }
      ws.send(JSON.stringify({ op: 'hello', topic: this.topic, ...this.auth }));
    };

    ws.onmessage = ev => {
      if (this.ws !== ws) return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      switch (msg.op) {
        case 'ready':
          this.subscribed = true;
          this.info = { isHost: !!msg.isHost, allowed: !!msg.allowed };
          // reenvia o último track ao reconectar e escoa o que ficou na fila
          if (this._lastTrack) ws.send(JSON.stringify({ op: 'track', payload: this._lastTrack }));
          for (const m of this._queue.splice(0)) { try { ws.send(m); } catch { /* ignora */ } }
          this._status('SUBSCRIBED', null);
          break;
        case 'denied':
          this.closed = true;
          this.subscribed = false;
          this._status('DENIED', new Error(msg.reason || 'denied'));
          try { ws.close(); } catch { /* ignora */ }
          break;
        case 'sync':
          this.state = msg.state || {};
          this._emit(this._presence.sync, {});
          break;
        case 'join':
          this._emit(this._presence.join, { newPresences: msg.news || [] });
          break;
        case 'leave':
          this._emit(this._presence.leave, { leftPresences: msg.lefts || [] });
          break;
        case 'bc':
          this._emit(this._broadcast.get(msg.event), { payload: msg.payload });
          break;
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.subscribed = false;
      if (this.closed) return;
      // o app já tem backoff próprio em scheduleRejoin()
      this._status('CHANNEL_ERROR', new Error('conexão perdida'));
    };

    ws.onerror = () => {
      if (this.ws !== ws || this.closed) return;
      this.subscribed = false;
      this._status('CHANNEL_ERROR', new Error('falha de socket'));
    };
  }

  _raw(obj) {
    const msg = JSON.stringify(obj);
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.subscribed) this.ws.send(msg);
    else if (!this.closed && this._queue.length < 64) this._queue.push(msg);
  }

  /** Só `sharing` e `role` são lidos pelo servidor; o resto da presença ele mesmo monta. */
  track(payload) {
    this._lastTrack = payload;
    this._raw({ op: 'track', payload });
  }

  /** event: 'signal' | 'control' */
  send(event, payload) {
    this._raw({ op: 'bc', event, payload });
  }

  unsubscribe() {
    this.closed = true;
    this.subscribed = false;
    this._queue.length = 0;
    const ws = this.ws;
    this.ws = null;
    if (ws) { try { ws.close(); } catch { /* ignora */ } }
  }
}

export function createApi() {
  return {
    channel: (topic, auth) => new Channel(topic, auth),

    async rpc(name, params) {
      try {
        const res = await fetch(baseUrl() + '/api/rpc/' + name, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(params || {})
        });
        return await parseJson(res);
      } catch (e) {
        return { data: null, error: { message: e.message, code: 'NETWORK' } };
      }
    },

    /** ICE servers (STUN + TURN com credencial temporária) vindos do servidor. */
    async config(uid) {
      try {
        const res = await fetch(baseUrl() + '/api/config?uid=' + encodeURIComponent(uid), { headers: { accept: 'application/json' } });
        return res.ok ? await res.json() : null;
      } catch { return null; }
    }
  };
}
