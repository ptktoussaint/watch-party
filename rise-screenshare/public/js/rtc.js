/* WebRTC: conexões ponto a ponto, negociação de oferta/resposta/ICE e controle de bitrate. */
import { $, S } from './state.js';
import { conn, toast } from './util.js';
import { flat, renderPeople } from './people.js';
import { send } from './realtime.js';
import { showLocal, showStream, updateStageView } from './stage.js';

export function rtc() { return { iceServers: S.iceServers, iceCandidatePoolSize: 10 }; }

export function queueIce(uid, candidate) { if (!S.pendingIce.has(uid)) S.pendingIce.set(uid, []); S.pendingIce.get(uid).push(candidate); }

export async function flushIce(uid, pc) { const list = S.pendingIce.get(uid) || []; for (const c of list) { try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { console.warn('ICE pendente', e); } } S.pendingIce.delete(uid); }

export function hasTrack(pc, track) {
  return pc.getSenders().some(s => s.track && s.track.id === track.id);
}

export async function ensureLocalTracks(pc) {
  if (!S.stream) return false;
  let added = false;
  for (const track of S.stream.getTracks()) {
    if (!hasTrack(pc, track)) {
      try { pc.addTrack(track, S.stream); added = true; console.log('[Rise] track adicionada ao peer', track.kind); } catch (e) { console.warn('ensureLocalTracks addTrack falhou', e); }
    }
  }
  if (added) scheduleTune();
  return added;
}

export async function renegotiatePeer(uid, pc) {
  if (!pc || pc.connectionState === 'closed' || pc.signalingState !== 'stable') return false;
  try {
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);
    send(uid, 'offer', { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
    return true;
  } catch (e) {
    console.warn('renegotiatePeer', uid, e);
    return false;
  }
}

export async function peer(uid, offerer = false) {
  let pc = S.peers.get(uid);
  if (pc && pc.connectionState === 'closed') { S.peers.delete(uid); pc = null; }
  if (!pc) {
    pc = new RTCPeerConnection(rtc()); S.peers.set(uid, pc);
    scheduleTune();
    if (S.stream) {
      for (const tr of S.stream.getTracks()) {
        try { pc.addTrack(tr, S.stream); } catch (e) { console.warn('addTrack init', e); }
      }
    }
    pc.onicecandidate = e => {
      if (e.candidate) {
        const c = e.candidate.toJSON ? e.candidate.toJSON() : e.candidate;
        send(uid, 'ice', { candidate: c });
      }
    };
    pc.ontrack = e => {
      let st = S.remoteStreams.get(uid);
      const incomingStream = e.streams?.[0];
      if (!st) {
        if (incomingStream) {
          st = new MediaStream(incomingStream.getTracks().slice());
        } else {
          st = new MediaStream([e.track]);
        }
        S.remoteStreams.set(uid, st);
      } else {
        const exists = st.getTracks().some(t => t.id === e.track.id);
        if (!exists) {
          try { st.addTrack(e.track); } catch { }
        }
        if (incomingStream) {
          for (const t of incomingStream.getTracks()) {
            if (!st.getTracks().some(x => x.id === t.id)) {
              try { st.addTrack(t); } catch { }
            }
          }
        }
      }
      e.track.onunmute = () => console.log('[Rise] track unmuted', uid, e.track.kind);
      e.track.onended = () => console.log('[Rise] track ended', uid, e.track.kind);
      S.remoteStreams.set(uid, st);
      renderPeople();
      const sel = $('#activeStream');
      if (!sel.value || sel.value === uid || sel.value === '') {
        sel.value = uid;
        showStream(uid);
      } else {
        const streamers = flat().filter(p => p.sharing);
        if (streamers.length && !sel.value) {
          sel.value = streamers[0].userId;
          showStream(streamers[0].userId);
        }
      }
    };
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connected') { conn(true, 'Conectado'); scheduleTune(); }
      if (state === 'failed') {
        console.warn('WebRTC falhou com', uid, pc.iceConnectionState);
        closePeer(uid);
        setTimeout(() => send(uid, 'stream-request', {}), 900);
      }
      if (state === 'disconnected') {
        console.warn('WebRTC disconnected', uid);
        setTimeout(() => {
          if (pc.connectionState === 'disconnected') {
            closePeer(uid);
            send(uid, 'stream-request', {});
          }
        }, 2800);
      }
    };
    pc.oniceconnectionstatechange = () => { /* debug */ };
  } else {
    if (S.stream) {
      await ensureLocalTracks(pc);
    }
  }
  if (offerer && pc.signalingState === 'stable') {
    try {
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      await pc.setLocalDescription(offer);
      send(uid, 'offer', { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
    } catch (e) {
      console.warn('createOffer falhou', uid, e, 'state', pc.signalingState);
    }
  } else if (offerer && pc.signalingState !== 'stable') {
    console.log('[Rise] offer adiado, signalingState', pc.signalingState, uid);
  }
  return pc;
}

export async function signal(p) {
  if (!p || (p.to && p.to !== S.uid) || p.from === S.uid) return;
  try {
    if (p.type === 'stream-request') {
      if (S.stream) {
        const now = Date.now();
        const last = S._reqThrottle.get(p.from) || 0;
        if (now - last < 800) return;
        S._reqThrottle.set(p.from, now);
        send(p.from, 'stream-available', { name: S.name });
      }
    } else if (p.type === 'stream-available') {
      const old = S.peers.get(p.from);
      if (old && S.remoteStreams.has(p.from) && ['connected', 'connecting'].includes(old.connectionState)) {
        return;
      }
      if (old && old.signalingState !== 'stable') {
        console.log('[Rise] stream-available ignorado, sinalização em progresso', p.from, old.signalingState);
        return;
      }
      await peer(p.from, true);
    } else if (p.type === 'stream-stopped') {
      const sel = $('#activeStream');
      const wasSelected = sel.value === p.from;
      closePeer(p.from);
      renderPeople();
      if (wasSelected) {
        const ps = flat().filter(x => x.sharing && x.userId !== p.from);
        const remoteStill = S.remoteStreams;
        let next = null;
        for (const cand of ps) {
          if (remoteStill.has(cand.userId) || cand.userId === S.uid) { next = cand.userId; break; }
        }
        if (!next && remoteStill.size > 0) {
          next = [...remoteStill.keys()][0];
        }
        if (next) {
          sel.value = next;
          showStream(next);
        } else if (S.stream) {
          showLocal();
        } else {
          updateStageView();
          sel.value = '';
        }
      }
    } else if (p.type === 'offer') {
      const pc = await peer(p.from, false);
      await ensureLocalTracks(pc);
      if (pc.signalingState === 'have-local-offer') {
        try { await pc.setLocalDescription({ type: 'rollback' }); } catch (e) { console.warn('rollback offer', e); }
      }
      await pc.setRemoteDescription(new RTCSessionDescription(p.data.sdp));
      await flushIce(p.from, pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send(p.from, 'answer', { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
    } else if (p.type === 'answer') {
      const pc = S.peers.get(p.from);
      if (!pc) return;
      if (pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(p.data.sdp));
        await flushIce(p.from, pc);
      } else {
        console.warn('[Rise] answer ignorado, state não é have-local-offer', pc.signalingState);
      }
    } else if (p.type === 'ice') {
      const pc = await peer(p.from, false);
      const c = p.data?.candidate;
      if (!c) return;
      if (pc.remoteDescription && pc.remoteDescription.type) {
        try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { console.warn('addIceCandidate falhou, enfileirando', e); queueIce(p.from, c); }
      } else {
        queueIce(p.from, c);
      }
    }
  } catch (e) { console.warn('WebRTC', p.type, p.from, e); toast('Falha na conexão da transmissão. Tentando novamente...'); }
}

export function closePeer(uid) {
  const pc = S.peers.get(uid);
  if (pc) {
    try { pc.ontrack = null; pc.onicecandidate = null; pc.onconnectionstatechange = null; pc.close(); } catch { }
    S.peers.delete(uid);
  }
  S.pendingIce.delete(uid);
  if (S.remoteStreams.has(uid)) {
    const st = S.remoteStreams.get(uid);
    try { st.getTracks().forEach(t => { try { t.stop(); } catch { } }); } catch { }
    S.remoteStreams.delete(uid);
  }
  scheduleTune();
}

export /** Quantos pares estão recebendo o vídeo que EU envio. */
function viewerCount() {
  if (!S.stream) return 0;
  const mine = new Set(S.stream.getVideoTracks());
  let n = 0;
  for (const pc of S.peers.values()) {
    if (pc.getSenders().some(s => s.track && mine.has(s.track))) n++;
  }
  return n;
}

export /**
 * Teto de bitrate por espectador. Em "Automática" o upload total é dividido entre
 * os espectadores; nas outras qualidades o teto é fixo (e a estimativa avisa o custo).
 */
function targetBitrate(viewers = viewerCount()) {
  const q = $('#quality')?.value || 'auto';
  const fps = Number($('#fps')?.value) || 30;
  const fpsFactor = fps >= 60 ? 1 : fps >= 30 ? 0.75 : 0.6;
  const cap = ({ 1080: 5_000_000, 720: 2_500_000, 480: 1_200_000 }[q] || 5_000_000) * fpsFactor;
  if (q !== 'auto') return Math.round(cap);
  const budget = 12_000_000, floor = 800_000;
  return Math.round(Math.max(floor, Math.min(cap, budget / Math.max(1, viewers))));
}

export async function tunePeer(pc) {
  if (!S.stream) return;
  const mine = new Set(S.stream.getVideoTracks());
  const bitrate = targetBitrate();
  const fps = Number($('#fps')?.value) || 30;
  for (const sender of pc.getSenders()) {
    if (!sender.track || !mine.has(sender.track)) continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = bitrate;
      params.encodings[0].maxFramerate = fps;
      params.degradationPreference = 'maintain-resolution'; // texto nítido > fluidez
      await sender.setParameters(params);
    } catch (e) { console.warn('[Rise] setParameters', e); }
  }
}

export function tuneAll() {
  for (const pc of S.peers.values()) tunePeer(pc);
  updateBitrateHint();
}

export function scheduleTune() {
  clearTimeout(S._tuneTimer);
  S._tuneTimer = setTimeout(tuneAll, 300);
}

export function updateBitrateHint() {
  const el = $('#bitrateHint');
  if (!el) return;
  const viewers = viewerCount();
  if (!S.stream || !viewers) {
    el.textContent = 'Cada espectador recebe um fluxo direto seu: quanto mais gente, mais upload.';
    el.classList.remove('audioWarn');
    return;
  }
  const mbps = (viewers * targetBitrate(viewers)) / 1e6;
  el.textContent = `Upload estimado: ~${mbps.toFixed(1)} Mbps para ${viewers} espectador${viewers > 1 ? 'es' : ''}.`;
  el.classList.toggle('audioWarn', mbps > 15);
  if (mbps > 15 && !S._warnedUpload) {
    S._warnedUpload = true;
    toast('Muitos espectadores para a sua internet: reduza a qualidade nos Ajustes');
  }
  if (mbps <= 15) S._warnedUpload = false;
}

export /** Qualidade/FPS alterados durante a transmissão valem na hora. */
async function applyQuality() {
  const vt = S.stream?.getVideoTracks()[0];
  if (vt) {
    const q = $('#quality').value, fps = Number($('#fps').value) || 30;
    const h = q === '720' ? 720 : q === '480' ? 480 : 1080;
    try { await vt.applyConstraints({ height: { ideal: h }, frameRate: { ideal: fps, max: fps } }); } catch (e) { console.warn('[Rise] applyConstraints', e); }
  }
  tuneAll();
}
