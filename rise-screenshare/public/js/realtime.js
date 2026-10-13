/* Canal em tempo real: presença, reconexão, mensagens de sinalização e de controle. */
import { S } from './state.js';
import { conn, toast } from './util.js';
import { setRoomUI } from './panels.js';
import { flat, normalizePresence, renderPeople, schedulePeople } from './people.js';
import { leave, roomPublic } from './room.js';
import { closePeer, signal } from './rtc.js';
import { stopShare } from './share.js';
import { autoSelectIfNeeded } from './stage.js';

export /** O servidor só lê `sharing` e `role`; identidade, host e permissão ele mesmo carimba. */
function presencePayload() {
  return { sharing: !!S.stream, role: S.role };
}

export function track(force = false) {
  if (!S.channel) return;
  const payload = presencePayload();
  const sig = JSON.stringify(payload);
  if (!force && S._lastTrack === sig) return;
  S.channel.track(payload);
  S._lastTrack = sig;
}

export /** Busca STUN/TURN no servidor (credencial TURN é temporária, então renova de tempos em tempos). */
async function refreshIce() {
  const c = await S.api.config(S.uid);
  if (c?.iceServers?.length) S.iceServers = c.iceServers;
}

export function deniedMessage(reason) {
  return ({
    password: 'Senha incorreta',
    locked: 'A sala está trancada pelo host',
    kicked: 'Você foi removido desta sala',
    full: 'A sala está cheia',
    'not-found': 'Sala não encontrada ou expirada',
    rate: 'Muitas tentativas. Aguarde um pouco e tente de novo.'
  })[reason] || 'Não foi possível entrar na sala';
}

export function extractPresenceUsers(presences) {
  const users = [];
  for (const item of presences || []) {
    if (Array.isArray(item)) users.push(...item);
    else if (item && typeof item === 'object') users.push(item);
  }
  return users.map(normalizePresence).filter(Boolean);
}

export function clearRealtimeTimers() {
  for (const k of ['_roomInt', '_iceInt', '_rejoinTimer']) {
    if (S[k]) { clearInterval(S[k]); clearTimeout(S[k]); S[k] = null; }
  }
}

export function scheduleRejoin() {
  if (S._rejoinTimer || S._leaving || !S.code) return;
  S._joinAttempts = (S._joinAttempts || 0) + 1;
  const delay = Math.min(15000, 2500 * S._joinAttempts);
  S._rejoinTimer = setTimeout(() => {
    S._rejoinTimer = null;
    if (!S._leaving && S.code) joinRealtime();
  }, delay);
}

export async function joinRealtime() {
  if (!S.api || !S.code || S._replacing) return;
  S._leaving = false;
  S._replacing = true;
  if (!S.joined) conn(false, 'Conectando');
  if (S.channel) {
    const old = S.channel;
    S.channel = null;
    old.unsubscribe();
  }
  S._lastTrack = null;
  await refreshIce();

  const ch = S.api.channel('rise-' + String(S.code).toUpperCase(), { uid: S.uid, name: S.name, ...S.auth });
  S.channel = ch;
  S._replacing = false;

  ch.on('presence', { event: 'sync' }, () => {
    S.presence = ch.presenceState();
    schedulePeople();
    requestStreamFromSharers();
    if (S.stream) {
      const now = Date.now();
      if (now - S._lastAnnounce > 1200) {
        S._lastAnnounce = now;
        send(null, 'stream-available', { name: S.name });
      }
    }
    autoSelectIfNeeded();
  });
  ch.on('presence', { event: 'leave' }, ({ leftPresences }) => {
    for (const p of extractPresenceUsers(leftPresences)) {
      if (!p.userId || p.userId === S.uid) continue;
      const prev = S._leaveTimers.get(p.userId);
      if (prev) clearTimeout(prev);
      S._leaveTimers.set(p.userId, setTimeout(() => {
        S._leaveTimers.delete(p.userId);
        if (!flat().some(x => x.userId === p.userId)) closePeer(p.userId);
      }, 4000));
    }
    schedulePeople();
  });
  ch.on('presence', { event: 'join' }, ({ newPresences }) => {
    for (const p of extractPresenceUsers(newPresences)) {
      const pending = S._leaveTimers.get(p.userId);
      if (pending) { clearTimeout(pending); S._leaveTimers.delete(p.userId); }
    }
    schedulePeople();
  });
  ch.on('broadcast', { event: 'signal' }, ({ payload }) => signal(payload));
  ch.on('broadcast', { event: 'control' }, ({ payload }) => control(payload));

  ch.subscribe((st, err) => {
    if (S.channel !== ch) return;
    if (st === 'SUBSCRIBED') {
      S.joined = true;
      S._joinAttempts = 0;
      // quem manda é o servidor: host e permissão de transmitir vêm da autenticação dele
      S.host = ch.info.isHost;
      S.shareAllowed = ch.info.allowed;
      setRoomUI();
      track(true);
      conn(true, 'Conectado');
      renderPeople();
      if (!S.remoteStreams.size) {
        setTimeout(() => { if (S.channel === ch) send(null, 'stream-request', {}); }, 550);
      }
      clearRealtimeTimers();
      S._roomInt = setInterval(() => refreshRoom(), 30000);
      S._iceInt = setInterval(() => refreshIce(), 30 * 60000);
    } else if (st === 'DENIED') {
      toast(deniedMessage(err?.message));
      leave();
    } else if (!S._leaving && !S._replacing && S.code && st === 'CHANNEL_ERROR') {
      console.warn('Rise realtime', st, err || '');
      conn(false, 'Reconectando');
      scheduleRejoin();
    }
  });
}

export async function refreshRoom() {
  if (!S.code) return;
  let r;
  try { r = await roomPublic(S.code); } catch { return; } // sem rede: o canal cuida de reconectar
  if (!r || r.closed) { toast('Sala encerrada'); leave(); return; }
  S.room = r;
  setRoomUI();
}

export /** Sinalização WebRTC; `to: null` vai para todos. O servidor carimba `from`. */
function send(to, type, data = {}) {
  S.channel?.send('signal', { to, type, data });
}

export /** Controles de sala (kick, share-permission): só o host é obedecido, e a checagem é do servidor. */
function broadcastControl(type, data = {}, to = null) {
  S.channel?.send('control', { to, type, data });
}

export function permit(uid, allowed = true) {
  if (!S.host) return;
  broadcastControl('share-permission', { allowed }, uid);
  toast(allowed ? 'Permissão enviada' : 'Permissão revogada');
}

export function kick(uid) {
  if (!S.host) return;
  broadcastControl('kick', {}, uid);
  toast('Participante expulso');
}

export /** Mensagens de controle só valem se vierem do servidor. */
function control(p) {
  if (!p || p.from !== 'server' || (p.to && p.to !== S.uid)) return;
  switch (p.type) {
    case 'kick':
      S._leaving = true; // não tenta reconectar
      toast('Você foi removido pelo host');
      setTimeout(() => leave(), 600);
      break;
    case 'room-closed':
      S._leaving = true;
      toast('Sala encerrada pelo host');
      setTimeout(() => leave(), 700);
      break;
    case 'share-permission': {
      const allowed = !!p.data?.allowed;
      const changed = S.shareAllowed !== allowed;
      S.shareAllowed = allowed;
      if (!allowed && S.stream) stopShare();
      if (changed) toast(allowed ? 'Host liberou sua transmissão' : 'Transmissão bloqueada');
      renderPeople();
      break;
    }
    case 'room-state':
      S.room = { ...S.room, ...p.data };
      setRoomUI();
      break;
  }
}

export function requestStreamFromSharers() {
  for (const p of flat()) {
    if (!p.sharing || p.userId === S.uid) continue;
    if (S.remoteStreams.has(p.userId)) continue;
    const key = 'req:' + p.userId;
    const now = Date.now();
    const last = S._reqThrottle.get(key) || 0;
    if (now - last < 1500) continue;
    S._reqThrottle.set(key, now);
    send(p.userId, 'stream-request', {});
  }
}
