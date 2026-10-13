export const $ = s => document.querySelector(s);
export const $$ = s => [...document.querySelectorAll(s)];

export const cfg = window.RISE_CONFIG || {};

/** localStorage pode lançar exceção (modo privado, cota); nunca deixe isso derrubar o app. */
export const ls = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* ignora */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignora */ } }
};

/** Identidade por aba: duas abas no mesmo navegador viram duas pessoas, não uma colisão. */
function tabUid() {
  try {
    let id = sessionStorage.getItem('rise_uid');
    if (!id) { id = crypto.randomUUID(); sessionStorage.setItem('rise_uid', id); }
    return id;
  } catch { return crypto.randomUUID(); }
}

/** Estado global da aplicação. */
export const S = {
  uid: tabUid(),
  name: ls.get('rise_name') || '',
  api: null,             // cliente de rede (client.js)
  code: null,
  room: null,
  host: false,
  hostToken: null,
  auth: {},              // { host_token_hash } ou { password_hash }, reenviado a cada reconexão
  channel: null,
  presence: {},
  stream: null,
  shareHasAudio: false,
  peers: new Map(),
  remoteStreams: new Map(),
  shareAllowed: false,
  role: 'spectator',
  pendingIce: new Map(),
  iceServers: cfg.ICE_SERVERS || [{ urls: 'stun:stun.l.google.com:19302' }],
  joined: false,
  joinedAt: null,
  _leaving: false,
  _replacing: false,
  _joinAttempts: 0,
  _lastTrack: null,
  _leaveTimers: new Map(),
  _lastAnnounce: 0,
  _reqThrottle: new Map()
};
