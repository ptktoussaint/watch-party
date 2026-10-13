/* Palco: vídeo principal, grade de miniaturas, modo galeria e tela cheia. */
import { $, S } from './state.js';
import { avatarColor, esc, initials, toast } from './util.js';
import { togglePeople, toggleTools } from './panels.js';
import { flat, nameOf } from './people.js';
import { requestStreamFromSharers, send } from './realtime.js';

export function tileStreamFor(uid) {
  if (uid === S.uid) return S.stream || null;
  return S.remoteStreams.get(uid) || null;
}

export function tileSignature(ps, activeUid) {
  return ps.map(p => [
    p.userId,
    p.name,
    p.sharing ? 1 : 0,
    tileStreamFor(p.userId) ? 1 : 0,
    p.userId === activeUid ? 1 : 0
  ].join(':')).join('|');
}

export function attachTileVideos(grid) {
  grid.querySelectorAll('[data-tile-video]').forEach(vid => {
    const uid = vid.dataset.tileVideo;
    const stream = tileStreamFor(uid);
    if (stream && vid.srcObject !== stream) {
      vid.srcObject = stream;
      vid.muted = true;
      vid.playsInline = true;
      vid.play().catch(err => console.warn('tile play', uid, err));
    } else if (!stream) {
      vid.srcObject = null;
    }
  });
}

export function applyGalleryMode() {
  const stage = $('#stage');
  if (!stage) return;
  const n = flat().length;
  const sharing = !!S.stream || flat().some(p => p.sharing);
  const gallery = !sharing && n > 0;
  stage.classList.toggle('galleryMode', gallery);
  stage.dataset.count = String(n);
  const empty = $('#emptyStage');
  if (empty && gallery) empty.style.display = 'none';
  return gallery;
}

export function renderTileGrid() {
  applyGalleryMode();
  const grid = $('#tileGrid');
  if (!grid) return;
  const ps = flat();
  if (!ps.length) { grid.innerHTML = ''; grid.dataset.sig = ''; return; }

  const sel = $('#activeStream');
  let activeUid = sel?.value || '';
  if (activeUid === S.uid && S.stream) activeUid = S.uid;
  else if (!activeUid || (activeUid === S.uid && !S.stream)) {
    const sharer = ps.find(p => p.sharing && p.userId !== S.uid && S.remoteStreams.has(p.userId))
      || ps.find(p => p.sharing && p.userId !== S.uid)
      || ps.find(p => p.sharing);
    if (sharer) activeUid = sharer.userId;
  }

  const sig = tileSignature(ps, activeUid);
  if (grid.dataset.sig === sig) {
    attachTileVideos(grid);
    return;
  }
  grid.dataset.sig = sig;

  const sorted = [...ps].sort((a, b) => {
    if (a.userId === S.uid) return 1;
    if (b.userId === S.uid) return -1;
    if (a.sharing && !b.sharing) return -1;
    if (!a.sharing && b.sharing) return 1;
    return String(a.joinedAt || '').localeCompare(String(b.joinedAt || ''));
  });

  const screenIcon = '<svg viewBox="0 0 24 24"><path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/></svg>';

  grid.innerHTML = sorted.map(p => {
    const self = p.userId === S.uid;
    const sharing = !!p.sharing;
    const selected = activeUid === p.userId;
    const label = self ? `${p.name || 'Você'} (você)` : (p.name || 'Participante');
    const avColor = avatarColor(p.name);
    const hasStream = !!tileStreamFor(p.userId);
    return `<button type="button" class="tile${self ? ' self' : ''}${sharing ? ' sharing' : ''}${selected ? ' selected' : ''}" data-tile-uid="${esc(p.userId)}" title="${esc(label)}">
      <div class="tileMedia">${hasStream ? `<video autoplay playsinline muted data-tile-video="${esc(p.userId)}"></video>` : `<div class="tileAvatar" style="background:${avColor}">${esc(initials(p.name))}</div>`}</div>
      <span class="tileLive">AO VIVO</span>
      <span class="tileBadge" aria-hidden="true">${screenIcon}</span>
      <span class="tileName">${esc(self ? 'Você' : p.name)}</span>
    </button>`;
  }).join('');

  attachTileVideos(grid);

  grid.querySelectorAll('[data-tile-uid]').forEach(btn => {
    btn.onclick = () => {
      const uid = btn.dataset.tileUid;
      if (uid === S.uid && S.stream) {
        if (sel) sel.value = S.uid;
        updateStageView(S.uid);
      } else if (S.remoteStreams.has(uid) || flat().some(p => p.userId === uid && p.sharing)) {
        if (sel) sel.value = uid;
        updateStageView(uid);
        if (!S.remoteStreams.has(uid)) send(uid, 'stream-request', {});
      } else if (!$('#stage')?.classList.contains('galleryMode')) {
        toast('Este participante não está transmitindo');
      }
      renderTileGrid();
    };
  });
}

export function autoSelectIfNeeded() {
  requestStreamFromSharers();
  const sel = $('#activeStream');
  if (sel?.value && (S.remoteStreams.has(sel.value) || (sel.value === S.uid && S.stream))) {
    updateStageView(sel.value);
    return;
  }
  const streamers = flat().filter(p => p.sharing);
  for (const p of streamers) {
    if (S.remoteStreams.has(p.userId)) {
      if (sel) sel.value = p.userId;
      updateStageView(p.userId);
      return;
    }
    if (p.userId === S.uid && S.stream) {
      if (sel) sel.value = p.userId;
      updateStageView(S.uid);
      return;
    }
  }
  updateStageView();
}

export function showLocal() { updateStageView(S.uid); }

export function showStream(uid) { updateStageView(uid); }

export async function playMainVideo(main) {
  const unmuteBtn = $('#unmuteVideo');
  main.muted = false;
  main.playsInline = true;
  main.autoplay = true;
  if (unmuteBtn) unmuteBtn.classList.add('hidden');
  try {
    await main.play();
  } catch {
    main.muted = true;
    try { await main.play(); } catch { }
    if (unmuteBtn) unmuteBtn.classList.remove('hidden');
    toast('Clique em "Ativar áudio" se não ouvir som');
  }
}

export function activateMainAudio() {
  const main = $('#video');
  const unmuteBtn = $('#unmuteVideo');
  if (!main?.srcObject) return;
  main.muted = false;
  main.play().then(() => {
    if (unmuteBtn) unmuteBtn.classList.add('hidden');
    toast('Áudio ativado');
  }).catch(() => toast('Não foi possível ativar o áudio'));
}

export function updateStageView(preferredUid) {
  const stage = $('#stage');
  const main = $('#video');
  const empty = $('#emptyStage');
  const presenting = $('#presentingStage');
  const lb = $('#liveBadge');
  const sel = $('#activeStream');
  if (!stage) return;

  let watchUid = preferredUid || sel?.value || '';
  if (watchUid === S.uid && S.stream) {
    /* mantém S.uid para estado "apresentando" */
  } else if (watchUid === S.uid) {
    watchUid = '';
  }

  let remoteStream = null;
  if (watchUid && watchUid !== S.uid && S.remoteStreams.has(watchUid)) {
    remoteStream = S.remoteStreams.get(watchUid);
  } else if (!S.stream || (watchUid && watchUid !== S.uid)) {
    const others = flat().filter(p => p.sharing && p.userId !== S.uid);
    for (const p of others) {
      if (S.remoteStreams.has(p.userId)) {
        watchUid = p.userId;
        remoteStream = S.remoteStreams.get(p.userId);
        break;
      }
    }
  }

  if (remoteStream && main) {
    stage.classList.remove('presentingOnly', 'galleryMode');
    if (empty) empty.style.display = 'none';
    if (presenting) presenting.style.display = 'none';
    if (main.srcObject !== remoteStream) {
      main.srcObject = remoteStream;
      playMainVideo(main);
    }
    main.style.display = 'block';
    if (sel && watchUid) sel.value = watchUid;
    if (lb) lb.style.display = 'flex';
    const ln = $('#liveName');
    if (ln) ln.textContent = nameOf(watchUid) || 'transmitindo';
  } else if (S.stream && (!watchUid || watchUid === S.uid)) {
    stage.classList.add('presentingOnly');
    stage.classList.remove('galleryMode');
    if (main) { main.srcObject = null; main.style.display = 'none'; try { main.pause(); } catch { } }
    if (empty) empty.style.display = 'none';
    if (presenting) presenting.style.display = 'flex';
    if (sel) sel.value = S.uid;
    if (lb) lb.style.display = 'flex';
    const ln = $('#liveName');
    if (ln) ln.textContent = S.name;
  } else {
    stage.classList.remove('presentingOnly');
    if (main && main.srcObject) {
      main.srcObject = null;
      main.style.display = 'none';
      try { main.pause(); } catch { }
    } else if (main) {
      main.style.display = 'none';
    }
    if (presenting) presenting.style.display = 'none';
    const hasStreamers = flat().some(p => p.sharing);
    const waitingRemote = watchUid && watchUid !== S.uid && !remoteStream && hasStreamers;
    applyGalleryMode();
    if (empty) {
      if (waitingRemote) {
        empty.style.display = 'flex';
        const hint = $('#stageEmptyHint');
        if (hint) hint.textContent = `Conectando transmissão de ${nameOf(watchUid) || 'participante'}...`;
      } else {
        empty.style.display = (stage.classList.contains('galleryMode') || hasStreamers) ? 'none' : 'flex';
      }
    }
    if (lb) lb.style.display = hasStreamers ? 'flex' : 'none';
    if (waitingRemote) send(watchUid, 'stream-request', {});
    else if (watchUid && watchUid !== S.uid && !remoteStream) send(watchUid, 'stream-request', {});
  }
  renderTileGrid();
}

export function fsElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement || null;
}

export function isFullscreen() {
  const el = fsElement();
  const app = $('#app');
  return !!el && (el === app || el === $('#stage'));
}

export async function toggleFullscreen() {
  const app = $('#app');
  if (!app) return;
  try {
    if (isFullscreen()) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
      if (exit) await exit.call(document);
    } else {
      toggleTools(false);
      togglePeople(false);
      const req = app.requestFullscreen || app.webkitRequestFullscreen || app.msRequestFullscreen;
      if (!req) return toast('Tela cheia não suportada neste navegador');
      await req.call(app);
    }
  } catch (e) {
    console.warn('fullscreen', e);
    toast('Não foi possível alternar tela cheia');
  }
  syncFullscreenUI();
}

export function syncFullscreenUI() {
  const on = isFullscreen();
  const app = $('#app');
  const btn = $('#fullscreen');
  if (app) app.classList.toggle('isFullscreen', on);
  if (on) {
    const main = $('#video');
    if (main?.srcObject) playMainVideo(main);
  }
  if (btn) {
    btn.classList.toggle('ctrlActive', on);
    btn.title = on ? 'Sair da tela cheia (Esc)' : 'Tela cheia';
    const label = btn.querySelector('.ctrlLabel');
    if (label) label.textContent = on ? 'Reduzir' : 'Expandir';
    const svg = btn.querySelector('.ctrlIcon path');
    if (svg) {
      svg.setAttribute('d', on
        ? 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z'
        : 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z');
    }
  }
}
