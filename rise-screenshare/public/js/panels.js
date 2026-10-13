/* Layout: tela de entrada x sala, painéis laterais, relógio, convite e QR Code. */
import { $, S } from './state.js';
import { avatarColor, initials, openModal, toast } from './util.js';
import { flat } from './people.js';

export function setRoomUI() {
  const rc = $('#roomCode'); if (rc) rc.textContent = S.code || '—';
  const selfAv = $('#stageSelfAvatar');
  if (selfAv) {
    selfAv.textContent = initials(S.name);
    selfAv.style.background = avatarColor(S.name);
  }
  const selfName = $('#stageSelfName'); if (selfName) selfName.textContent = S.name || 'Você';
  document.title = S.code ? `${S.room?.title || 'Sessão'} · Rise` : 'Rise';
  document.body.classList.toggle('hostView', S.host);
  const appEl = $('#app'); if (appEl) appEl.classList.toggle('isHost', S.host);
  const ht = $('#hostTools'); if (ht) ht.style.display = S.host ? 'flex' : 'none';
  const lb = $('#lockBtn');
  if (lb) {
    lb.classList.toggle('hidden', !S.host);
    lb.title = S.room?.locked ? 'Sala trancada — clique para abrir' : 'Trancar sala';
    lb.classList.toggle('ctrlActive', !!S.room?.locked);
  }
  const ln = $('#liveName'); if (ln) { const sharer = flat().find(p => p.sharing); ln.textContent = sharer ? sharer.name : 'transmitindo'; }
}

export function startMeetClock() {
  if (S._clockTimer) clearInterval(S._clockTimer);
  S._clockStart = Date.now();
  const tick = () => {
    const el = $('#clockTime');
    if (!el) return;
    const s = Math.floor((Date.now() - S._clockStart) / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    el.textContent = h > 0
      ? `${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
      : `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  tick();
  S._clockTimer = setInterval(tick, 1000);
}

export function syncScrim() {
  const open = $('#app')?.classList.contains('peopleOpen') || $('#tools')?.classList.contains('show');
  const scrim = $('#peopleScrim');
  if (scrim) scrim.hidden = !open;
}

export function togglePeople(force) {
  const app = $('#app');
  if (!app) return;
  const open = typeof force === 'boolean' ? force : !app.classList.contains('peopleOpen');
  app.classList.toggle('peopleOpen', open);
  $('#togglePeople')?.classList.toggle('ctrlActive', open);
  if (open) {
    $('#tools')?.classList.remove('show');
    $('#openTools')?.classList.remove('ctrlActive');
  }
  syncScrim();
}

export function toggleTools(force) {
  const tools = $('#tools');
  if (!tools) return;
  const open = typeof force === 'boolean' ? force : !tools.classList.contains('show');
  tools.classList.toggle('show', open);
  $('#openTools')?.classList.toggle('ctrlActive', open);
  if (open) {
    $('#app')?.classList.remove('peopleOpen');
    $('#togglePeople')?.classList.remove('ctrlActive');
  }
  syncScrim();
}

export function showApp() { $('#landing').classList.remove('show'); $('#app').classList.add('show'); setRoomUI(); startMeetClock(); }

export function showLanding() {
  $('#app').classList.remove('show');
  $('#landing').classList.add('show');
  setInviteMode(new URL(location.href).searchParams.get('room'));
}

export function setInviteMode(code) {
  const landing = $('#landing');
  if (!landing) return;
  const c = String(code || '').trim().toUpperCase();
  const on = !!c;
  landing.classList.toggle('inviteMode', on);
  const title = $('#homeCardTitle');
  const lead = $('#homeCardLead');
  const codeEl = $('#inviteCodeLabel');
  if (on) {
    if ($('#joinCode')) $('#joinCode').value = c;
    if (title) title.textContent = 'Você foi convidado';
    if (lead) lead.textContent = 'Digite um nome para entrar. Sem um nome a sala não libera o acesso.';
    if (codeEl) codeEl.textContent = c;
  } else if (title) {
    title.textContent = 'Entrar';
    if (lead) lead.textContent = 'Escolha um nickname para ser identificado na sala.';
  }
}

export function requireDisplayName() {
  const input = $('#displayName');
  const name = (input?.value || '').trim();
  if (name) {
    input?.classList.remove('homeInputError');
    return name;
  }
  input?.classList.add('homeInputError');
  input?.focus();
  toast('Digite um nome para entrar');
  return '';
}

export function invite() {
  const u = new URL(location.href);
  u.search = '';
  u.searchParams.set('room', S.code);
  return u.toString();
}

export function qr() { const body = document.createElement('div'); body.innerHTML = '<h2>QR Code da sala</h2><p>Escaneie para entrar.</p><div id="qrcode"></div>'; openModal(body); setTimeout(() => new window.QRCode($('#qrcode'), { text: invite(), width: 220, height: 220 }), 20); }
