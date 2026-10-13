/* Lista de pessoas (presença) e ações do host sobre cada uma. */
import { $, $$, S } from './state.js';
import { avatarColor, esc, initials } from './util.js';
import { kick, permit } from './realtime.js';
import { renderTileGrid, updateStageView } from './stage.js';

export function normalizePresence(p) {
  if (!p || typeof p !== 'object') return null;
  const src = Array.isArray(p.metas) && p.metas[0] ? p.metas[0] : p;
  const userId = src.userId || src.user_id || p.userId || p.user_id;
  if (!userId) return null;
  return { ...src, userId };
}

export function flat() {
  const out = [];
  const seen = new Set();
  for (const key of Object.keys(S.presence || {})) {
    const val = S.presence[key];
    const list = Array.isArray(val) ? val : (val ? [val] : []);
    for (const raw of list) {
      const p = normalizePresence(raw);
      if (!p || seen.has(p.userId)) continue;
      seen.add(p.userId);
      out.push(p);
    }
  }
  return out.sort((a, b) => String(a.joinedAt || '').localeCompare(String(b.joinedAt || '')));
}

export function personStatus(p, self) {
  if (self) return 'Você';
  if (p.sharing) return 'Transmitindo';
  if (p.isHost || p.shareAllowed) return 'Pode transmitir';
  if (p.role === 'participant') return 'Participante';
  return 'Na sala';
}

export function nameOf(uid) { return flat().find(p => p.userId === uid)?.name || uid; }

export function renderPeople() {
  const ps = flat(), n = ps.length;
  const streamers = ps.filter(p => p.sharing);
  const countEl = $('#participantsCount');
  if (countEl) countEl.textContent = n === 1 ? '1 na sala' : `${n} na sala`;
  const peopleBadge = $('#peopleBadge');
  if (peopleBadge) peopleBadge.textContent = n;

  const emptyHint = $('#stageEmptyHint');
  if (emptyHint) {
    if (S.stream) {
      emptyHint.textContent = 'Você está apresentando para a sala';
    } else if (streamers.length) {
      const names = streamers.map(s => s.name).slice(0, 2).join(', ');
      emptyHint.textContent = `${names} está apresentando`;
    } else if (n > 1) {
      emptyHint.textContent = 'Ninguém está apresentando no momento';
    } else {
      emptyHint.textContent = 'Use Apresentar na barra inferior para compartilhar sua tela';
    }
  }

  const peopleEl = $('#people');
  if (peopleEl) {
    peopleEl.innerHTML = ps.map(p => {
      const self = p.userId === S.uid;
      const status = personStatus(p, self);
      let actions = '';
      if (S.host && !self && !p.isHost) {
        const allowed = !!p.shareAllowed;
        actions = `<div class="personActions">`;
        if (allowed) {
          actions += `<button class="revokeBtn" data-revoke="${esc(p.userId)}" title="Revogar transmissão">Revogar</button>`;
        } else {
          actions += `<button class="permitBtn" data-permit="${esc(p.userId)}" title="Liberar transmissão">Liberar tela</button>`;
        }
        actions += `<button class="kickBtn" data-kick="${esc(p.userId)}" title="Expulsar">Expulsar</button></div>`;
      }
      const hostTag = p.isHost ? '<span class="tag">HOST</span>' : '';
      const avColor = avatarColor(p.name);
      return `<div class="person"><div class="avatar" style="background:${avColor}">${esc(initials(p.name))}</div><div class="info"><b>${esc(p.name)} ${hostTag}</b><span>${esc(status)}</span></div>${actions}</div>`;
    }).join('') || '<div class="person"><div class="info"><span>Conectando...</span></div></div>';
  }

  const info = $('#participantsInfo');
  if (info) {
    if (streamers.length) {
      const names = streamers.map(s => s.name).slice(0, 2).join(', ');
      const extra = streamers.length > 2 ? ` +${streamers.length - 2}` : '';
      info.textContent = `${n} na sala • ${names}${extra} transmitindo`;
    } else if (n > 1) {
      info.textContent = `${n} na sala • ninguém transmitindo`;
    } else if (n === 1) {
      info.textContent = 'só você na sala • compartilhe sua tela';
    } else {
      info.textContent = 'conectando...';
    }
  }

  const liveNameEl = $('#liveName');
  if (liveNameEl) {
    const sharer = streamers[0];
    liveNameEl.textContent = sharer ? sharer.name : 'transmitindo';
  }

  const badge = $('#liveBadge');
  if (badge) {
    const hasLive = streamers.length > 0 || !!S.stream;
    badge.style.display = hasLive ? 'flex' : 'none';
  }

  const shareBtn2 = $('#shareScreen2'), stopBtn = $('#stopShare');
  const iAmSharing = !!S.stream;
  if (shareBtn2) { shareBtn2.classList.toggle('hidden', iAmSharing); shareBtn2.style.display = ''; }
  if (stopBtn) {
    stopBtn.classList.toggle('hidden', !iAmSharing);
    stopBtn.style.display = '';
  }

  const sel = $('#activeStream');
  if (sel) {
    const cur = sel.value;
    sel.innerHTML = '<option value="">Selecionar transmissão</option>' + streamers.map(p => `<option value="${esc(p.userId)}">${esc(p.name)}</option>`).join('');
    if (streamers.some(p => p.userId === cur)) {
      sel.value = cur;
    } else if (streamers.length) {
      sel.value = streamers[0].userId;
    } else {
      sel.value = '';
    }
    if (streamers.length <= 1) sel.style.display = 'none';
    else sel.style.display = 'block';
  }

  const stageSig = streamers.map(p => p.userId).join(',') + '|' + [...S.remoteStreams.keys()].join(',') + '|' + (S.stream ? 1 : 0) + '|' + (sel?.value || '') + '|' + n;
  if (S._stageSig !== stageSig) {
    S._stageSig = stageSig;
    if (!streamers.length && !S.stream) updateStageView();
    else updateStageView(sel?.value);
  } else {
    renderTileGrid();
  }

  $$('[data-kick]').forEach(b => b.onclick = () => kick(b.dataset.kick));
  $$('[data-permit]').forEach(b => b.onclick = () => permit(b.dataset.permit, true));
  $$('[data-revoke]').forEach(b => b.onclick = () => permit(b.dataset.revoke, false));
}

export function schedulePeople() {
  if (S._peopleTimer) return;
  S._peopleTimer = setTimeout(() => {
    S._peopleTimer = null;
    renderPeople();
  }, 80);
}
