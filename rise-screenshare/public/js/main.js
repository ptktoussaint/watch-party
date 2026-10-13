/* Ponto de entrada: liga botões e eventos aos módulos e inicia a tela de entrada. */
import { $, S, ls } from './state.js';
import { createApi } from './client.js';
import { askConfirm, askInput, closeModal, copy, toast } from './util.js';
import { invite, qr, setInviteMode, setRoomUI, toggleTools, togglePeople } from './panels.js';
import { activateMainAudio, showStream, syncFullscreenUI, toggleFullscreen } from './stage.js';
import { applyQuality } from './rtc.js';
import { startShare, stopShare } from './share.js';
import { createRoom, enterRoom, hostAction, leave } from './room.js';
import { track } from './realtime.js';

async function toggleLock() {
  if (!S.host) return;
  const locked = !S.room?.locked;
  if (await hostAction('lock', String(locked))) toast(locked ? 'Sala trancada' : 'Sala aberta');
}

async function closeRoom() {
  const ok = await askConfirm({
    title: 'Encerrar esta sala?',
    text: 'Todos serão desconectados e o código deixa de funcionar.',
    confirmText: 'Encerrar sala',
    danger: true
  });
  if (ok && await hostAction('close', 'true')) leave();
}

async function renameSession() {
  const t = await askInput({ title: 'Nome da sessão', value: S.room?.title || '', maxlength: 80, confirmText: 'Salvar' });
  if (t?.trim() && await hostAction('title', t.trim())) toast('Sessão renomeada');
}

function wireButtons() {
  const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };

  on('#createRoom', createRoom);
  on('#joinRoom', () => enterRoom($('#joinCode')?.value || ''));
  on('#joinInvite', () => enterRoom($('#joinCode')?.value || new URL(location.href).searchParams.get('room') || ''));
  on('#roomCode', () => copy(S.code, 'Código copiado'));
  on('#copyInvite', () => copy(invite(), 'Link copiado'));
  on('#showQr', qr);
  on('#shareScreen2', startShare);
  on('#stopShare', () => stopShare());
  on('#leaveRoom', () => leave());
  on('#openTools', () => toggleTools());
  on('#closeTools', () => toggleTools(false));
  on('#lockBtn', toggleLock);
  on('#closeRoom', closeRoom);
  on('#renameSession', renameSession);
  on('#fullscreen', () => toggleFullscreen());
  on('#unmuteVideo', activateMainAudio);
  on('#togglePeople', () => togglePeople());
  on('#closePeople', () => togglePeople(false));
  on('#peopleScrim', () => { togglePeople(false); toggleTools(false); });
  on('#modalClose', closeModal);

  const video = $('#video');
  if (video) video.onclick = () => { if (video.muted) activateMainAudio(); };

  const activeStream = $('#activeStream');
  if (activeStream) activeStream.onchange = e => showStream(e.target.value);

  const joinMode = $('#joinMode');
  if (joinMode) joinMode.onchange = e => { S.role = e.target.value; track(); setRoomUI(); };

  const shareAudio = $('#shareAudio');
  if (shareAudio) {
    shareAudio.checked = ls.get('rise_share_audio') !== '0';
    shareAudio.onchange = e => ls.set('rise_share_audio', e.target.checked ? '1' : '0');
  }

  $('#quality')?.addEventListener('change', applyQuality);
  $('#fps')?.addEventListener('change', applyQuality);
}

function wireGlobalEvents() {
  ['fullscreenchange', 'webkitfullscreenchange', 'MSFullscreenChange'].forEach(ev => {
    document.addEventListener(ev, syncFullscreenUI);
  });
  window.addEventListener('beforeunload', () => { S.stream?.getTracks().forEach(t => t.stop()); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.joined && !S._leaving) track(true);
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if ($('#modal')?.classList.contains('show')) $('#modalClose')?.click();
    else { togglePeople(false); toggleTools(false); }
  });
}

function wireEntryForm() {
  const nick = $('#displayName'), count = $('#nickCount');
  if (nick && count) {
    const update = () => { count.textContent = `${nick.value.length}/28`; nick.classList.remove('homeInputError'); };
    nick.addEventListener('input', update);
    if (S.name) nick.value = S.name;
    update();
  }

  const card = $('.homeCard');
  card?.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.repeat) return;
    const id = e.target?.id;
    if (id === 'joinCode') { e.preventDefault(); $('#joinRoom')?.click(); }
    else if (id === 'displayName' && $('#landing')?.classList.contains('inviteMode')) { e.preventDefault(); $('#joinInvite')?.click(); }
    else if (id === 'displayName' || id === 'roomTitle' || id === 'roomPassword') { e.preventDefault(); $('#createRoom')?.click(); }
  });

  const room = new URL(location.href).searchParams.get('room');
  if (room) {
    setInviteMode(room);
    setTimeout(() => $('#displayName')?.focus(), 50);
  }
}

S.api = createApi();
wireButtons();
wireGlobalEvents();
wireEntryForm();

// ajuda a depurar e a testar; não expõe nada que a aba já não tenha
window.__rise = { S };
