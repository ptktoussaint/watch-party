/* Captura de tela e áudio (getDisplayMedia) e início/fim da transmissão. */
import { $, ls, S } from './state.js';
import { closeModal, esc, openModal, toast } from './util.js';
import { flat, nameOf, renderPeople } from './people.js';
import { send, track } from './realtime.js';
import { ensureLocalTracks, renegotiatePeer, scheduleTune, updateBitrateHint } from './rtc.js';
import { renderTileGrid, showLocal, showStream } from './stage.js';

export function shareAudioEnabled() {
  const el = $('#shareAudio');
  if (!el) return ls.get('rise_share_audio') !== '0';
  return el.checked;
}

export function isAudioCaptureError(e) {
  if (!e || e.name === 'NotAllowedError' || e.name === 'AbortError') return false;
  const msg = String(e.message || e.name || '').toLowerCase();
  return msg.includes('audio');
}

export function captureSurface(stream) {
  return stream.getVideoTracks()[0]?.getSettings?.()?.displaySurface || '';
}

export function hasCapturableAudio(stream) {
  return stream.getAudioTracks().some(t => t.readyState === 'live' && t.enabled);
}

export function waitForAudioTrack(stream, ms = 2800) {
  if (hasCapturableAudio(stream)) return Promise.resolve(true);
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve(hasCapturableAudio(stream));
    };
    const onAdd = e => { if (e.track?.kind === 'audio') finish(); };
    const unmuteHandlers = [];
    for (const t of stream.getAudioTracks()) {
      const h = () => finish();
      unmuteHandlers.push([t, h]);
      t.addEventListener('unmute', h);
    }
    stream.addEventListener('addtrack', onAdd);
    const timer = setTimeout(finish, ms);
    function cleanup() {
      clearTimeout(timer);
      stream.removeEventListener('addtrack', onAdd);
      for (const [t, h] of unmuteHandlers) t.removeEventListener('unmute', h);
    }
  });
}

export function displayMediaOpts(profile) {
  const q = $('#quality').value, fps = Number($('#fps').value) || 30;
  const h = q === '720' ? 720 : q === '480' ? 480 : 1080;
  const baseVideo = { height: { ideal: h }, frameRate: { ideal: fps, max: fps } };
  if (profile === 'video') return { video: baseVideo, audio: false };
  const audio = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    suppressLocalAudioPlayback: false
  };
  if (profile === 'monitor') {
    return { video: { ...baseVideo, displaySurface: 'monitor' }, audio, systemAudio: 'include' };
  }
  if (profile === 'window') {
    return { video: baseVideo, audio, windowAudio: 'system', systemAudio: 'include' };
  }
  if (profile === 'basic') {
    return { video: baseVideo, audio, systemAudio: 'include', windowAudio: 'system' };
  }
  return { video: baseVideo, audio, systemAudio: 'include', windowAudio: 'system' };
}

export function captureProfiles(mode) {
  if (mode === 'monitor') return ['monitor', 'enhanced', 'basic'];
  if (mode === 'window') return ['window', 'enhanced', 'basic'];
  return ['enhanced', 'window', 'monitor', 'basic'];
}

export function isRetryableCaptureError(e, profile) {
  if (!e || e.name === 'NotAllowedError' || e.name === 'AbortError') return false;
  if (e.name === 'TypeError') return true;
  if (e.name === 'OverconstrainedError') return profile === 'monitor' || profile === 'window';
  return isAudioCaptureError(e);
}

export function shareAudioHint(surface) {
  if (surface === 'window') {
    return 'Janela sem áudio — escolha tela inteira e marque "Compartilhar áudio do sistema" no popup';
  }
  if (surface === 'monitor') {
    return 'Tela sem áudio — marque "Compartilhar áudio do sistema" no popup do Chrome/Edge';
  }
  return 'Áudio indisponível — transmitindo só vídeo';
}

export function ensureShareAudioGuide() {
  if (!shareAudioEnabled() || ls.get('rise_audio_guide') === '1') return Promise.resolve();
  return new Promise(resolve => {
    const body = document.createElement('div');
    body.innerHTML = [
      '<h2>Compartilhar com áudio</h2>',
      '<p><strong>Tela inteira:</strong> escolha o monitor e marque <strong>Compartilhar áudio do sistema</strong> no popup do navegador.</p>',
      '<p><strong>Janela de aplicativo:</strong> se o popup tiver opção de áudio, ligue-a. Caso contrário, volte e use <strong>tela inteira</strong>.</p>',
      '<p><strong>Aba do navegador:</strong> o áudio da aba costuma funcionar automaticamente.</p>',
      '<p class="toolsHint">Use Chrome ou Edge atualizado no Windows.</p>'
    ].join('');
    const actions = document.createElement('div');
    actions.className = 'modalActions';
    const btn = document.createElement('button');
    btn.className = 'btn btnPrimary';
    btn.type = 'button';
    btn.textContent = 'Entendi, continuar';
    btn.onclick = () => { ls.set('rise_audio_guide', '1'); closeModal(); resolve(); };
    actions.appendChild(btn);
    body.appendChild(actions);
    openModal(body);
  });
}

export function promptAudioRetry(surface) {
  return new Promise(resolve => {
    const isWindow = surface === 'window';
    const isMonitor = surface === 'monitor';
    const msg = isWindow
      ? 'O navegador não capturou áudio desta janela. Para transmitir o som do aplicativo, compartilhe a tela inteira e marque "Compartilhar áudio do sistema" no popup.'
      : isMonitor
        ? 'Áudio do sistema não foi detectado. No popup do Chrome/Edge, marque "Compartilhar áudio do sistema" antes de confirmar.'
        : 'Nenhuma faixa de áudio foi capturada. Tente novamente escolhendo tela inteira com áudio do sistema ligado no popup.';
    const body = document.createElement('div');
    body.innerHTML = `<h2>Áudio não detectado</h2><p>${esc(msg)}</p>`;
    const actions = document.createElement('div');
    actions.className = 'modalActions';
    const retry = document.createElement('button');
    retry.className = 'btn btnPrimary';
    retry.type = 'button';
    retry.textContent = isWindow ? 'Usar tela inteira com áudio' : 'Tentar novamente';
    retry.onclick = () => { closeModal(); resolve(isWindow ? 'monitor' : 'retry'); };
    const videoOnly = document.createElement('button');
    videoOnly.className = 'btn btnGhost';
    videoOnly.type = 'button';
    videoOnly.textContent = 'Continuar só com vídeo';
    videoOnly.onclick = () => { closeModal(); resolve('video'); };
    const cancel = document.createElement('button');
    cancel.className = 'btn btnQuiet';
    cancel.type = 'button';
    cancel.textContent = 'Cancelar';
    cancel.onclick = () => { closeModal(); resolve('cancel'); };
    actions.append(retry, videoOnly, cancel);
    body.appendChild(actions);
    openModal(body);
  });
}

export function syncShareAudioBadge() {
  const lb = $('#liveBadge');
  if (!lb || !S.stream) return;
  const ln = nameOf(S.uid) || S.name || 'transmitindo';
  if (shareAudioEnabled() && !S.shareHasAudio) {
    lb.innerHTML = `Ao vivo · <span id="liveName">${esc(ln)}</span> · <span class="audioWarn">sem áudio</span>`;
  } else if (S.shareHasAudio) {
    lb.innerHTML = `Ao vivo · <span id="liveName">${esc(ln)}</span> · <span class="audioOk">com áudio</span>`;
  }
}

export async function captureDisplayStream(mode = 'auto') {
  const wantAudio = shareAudioEnabled();
  if (!wantAudio) {
    const stream = await navigator.mediaDevices.getDisplayMedia(displayMediaOpts('video'));
    return { stream, hasAudio: false, surface: captureSurface(stream) };
  }

  const profiles = captureProfiles(mode);
  let lastError;
  for (const profile of profiles) {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia(displayMediaOpts(profile));
      await waitForAudioTrack(stream);
      return {
        stream,
        hasAudio: hasCapturableAudio(stream),
        surface: captureSurface(stream)
      };
    } catch (e) {
      lastError = e;
      if (e.name === 'NotAllowedError' || e.name === 'AbortError') throw e;
      if (!isRetryableCaptureError(e, profile)) throw e;
      console.warn('Rise: captura ' + profile + ' falhou', e);
    }
  }

  console.warn('Rise: perfis com áudio falharam, tentando só vídeo', lastError);
  const stream = await navigator.mediaDevices.getDisplayMedia(displayMediaOpts('video'));
  return { stream, hasAudio: false, surface: captureSurface(stream) };
}

export async function startShare() {
  if (!S.host && !S.shareAllowed) return toast('O host ainda não liberou sua transmissão');
  if (!window.isSecureContext || !navigator.mediaDevices?.getDisplayMedia) return toast('A telagem precisa abrir em HTTPS para compartilhar a tela');
  try {
    if (S.stream) await stopShare(true);
    await ensureShareAudioGuide();
    let captureMode = 'auto';
    let stream, hasAudio, surface;
    while (true) {
      ({ stream, hasAudio, surface } = await captureDisplayStream(captureMode));
      if (!shareAudioEnabled() || hasAudio) break;
      const choice = await promptAudioRetry(surface);
      if (choice === 'cancel') {
        stream.getTracks().forEach(t => { try { t.stop(); } catch { } });
        return;
      }
      if (choice === 'video') break;
      stream.getTracks().forEach(t => { try { t.stop(); } catch { } });
      captureMode = choice === 'monitor' ? 'monitor' : 'auto';
    }
    const vt = stream.getVideoTracks()[0]; if (!vt) throw new Error('Nenhuma tela foi selecionada');
    vt.contentHint = 'detail';
    vt.onended = () => stopShare();
    S.stream = stream;
    S.shareHasAudio = hasCapturableAudio(stream);
    // Força o tile de preview local a recriar e anexar o <video> imediatamente,
    // sem esperar o sync de presença (p.sharing ainda pode estar false aqui).
    const grid0 = $('#tileGrid');
    if (grid0) { grid0.dataset.sig = ''; }
    renderTileGrid();
    for (const [uid, pc] of S.peers) {
      const added = await ensureLocalTracks(pc);
      if (added && pc.signalingState === 'stable') await renegotiatePeer(uid, pc);
    }
    await track();
    showLocal();
    renderPeople();
    S._lastAnnounce = Date.now();
    send(null, 'stream-available', { name: S.name });
    setTimeout(() => send(null, 'stream-available', { name: S.name }), 800);
    scheduleTune();
    syncShareAudioBadge();
    if (shareAudioEnabled() && !S.shareHasAudio) toast(shareAudioHint(surface));
    else if (S.shareHasAudio) toast('Transmissão iniciada com áudio');
    else toast('Transmissão iniciada');
  } catch (e) { console.error('Rise getDisplayMedia', e); if (e.name === 'NotAllowedError') toast('Compartilhamento cancelado'); else toast('Não foi possível iniciar a telagem: ' + (e.message || 'erro do navegador')); }
}

export async function stopShare(silent = false) {
  if (!S.stream) return;
  const oldStream = S.stream;
  S.stream = null;
  S.shareHasAudio = false;
  send(null, 'stream-stopped', {});
  for (const [uid, pc] of [...S.peers.entries()]) {
    try {
      const senders = pc.getSenders().filter(s => s.track && oldStream.getTracks().some(t => t.id === s.track.id));
      for (const snd of senders) {
        try { pc.removeTrack(snd); } catch (e) { console.warn('removeTrack', e); }
      }
      const hasRemote = S.remoteStreams.has(uid);
      const isSharing = flat().some(p => p.userId === uid && p.sharing);
      if (senders.length && !hasRemote && !isSharing && pc.getSenders().filter(s => s.track).length === 0) {
        try { pc.close(); } catch { }
        S.peers.delete(uid);
        S.pendingIce.delete(uid);
      } else if (senders.length && pc.signalingState === 'stable') {
        await renegotiatePeer(uid, pc);
      }
    } catch (e) { console.warn('stopShare peer', uid, e); }
  }
  try { oldStream.getTracks().forEach(t => { try { t.stop(); } catch { } }); } catch { }
  S.pendingIce.clear();
  await track();
  const sel = $('#activeStream');
  const streamers = flat().filter(p => p.sharing);
  if (streamers.length) {
    const next = streamers.find(p => S.remoteStreams.has(p.userId)) || streamers[0];
    if (next) {
      sel.value = next.userId;
      if (next.userId === S.uid) showLocal(); else showStream(next.userId);
    }
  } else if (S.remoteStreams.size > 0) {
    const firstUid = [...S.remoteStreams.keys()][0];
    sel.value = firstUid;
    showStream(firstUid);
  } else {
    const v = $('#video');
    if (v) { v.srcObject = null; v.style.display = 'none'; try { v.pause(); } catch { } }
    $('#stage')?.classList.remove('presentingOnly');
    $('#emptyStage').style.display = 'flex';
    $('#presentingStage').style.display = 'none';
    $('#liveBadge').style.display = 'none';
    sel.value = '';
  }
  renderPeople();
  updateBitrateHint();
  if (!silent) toast('Transmissão encerrada');
}
