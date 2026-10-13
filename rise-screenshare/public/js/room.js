/* Ciclo de vida da sala: criar, entrar, ações do host e sair. */
import { $, ls, S } from './state.js';
import { askInput, conn, ensureApiReady, leaveFullscreenQuietly, makeCode, sha, toast } from './util.js';
import { requireDisplayName, setRoomUI, showApp, showLanding, togglePeople, toggleTools } from './panels.js';
import { clearRealtimeTimers, joinRealtime, send } from './realtime.js';
import { isFullscreen, syncFullscreenUI } from './stage.js';

export async function roomPublic(c) {
  const { data, error } = await S.api.rpc('rise_room_public', { p_code: c.toUpperCase() });
  if (error) throw new Error(error.message);
  return data?.[0] || null;
}

export async function createRoom() {
  try { ensureApiReady(); } catch (e) { return toast(e.userMessage || e.message); }
  S.name = requireDisplayName();
  if (!S.name) return;
  ls.set('rise_name', S.name);
  const title = $('#roomTitle').value.trim() || 'Sessão Rise';
  const pass = $('#roomPassword').value;
  S.hostToken = crypto.randomUUID() + crypto.randomUUID();
  const btn = $('#createRoom');
  btn.disabled = true; btn.textContent = 'Criando sala...';
  try {
    const tokenHash = await sha(S.hostToken);
    const passHash = pass ? await sha(pass) : null;
    for (let i = 0; i < 8; i++) {
      const c = makeCode();
      const { data, error } = await S.api.rpc('rise_create_room', {
        p_code: c, p_title: title, p_host_name: S.name, p_host_token_hash: tokenHash, p_password_hash: passHash
      });
      if (error) throw new Error(error.message);
      if (data !== true) continue; // código em uso: sorteia outro
      S.code = c; S.host = true; S.shareAllowed = true;
      S.auth = { host_token_hash: tokenHash };
      ls.set('rise_host_' + c, S.hostToken);
      history.replaceState({}, '', `${location.pathname}?room=${encodeURIComponent(c)}`);
      S.room = await roomPublic(c);
      if (!S.room) throw new Error('Sala criada, mas não pôde ser lida.');
      S.joinedAt = new Date().toISOString();
      showApp(); await joinRealtime(); toast('Sala criada com sucesso');
      return;
    }
    throw new Error('Não foi possível gerar um código único para a sala.');
  } catch (error) {
    console.error('Rise createRoom:', error);
    toast(error?.userMessage || 'Erro ao criar sala: ' + (error?.message || 'verifique a conexão'));
  } finally { btn.disabled = false; btn.textContent = 'Criar sala'; }
}

export async function enterRoom(c) {
  try { ensureApiReady(); } catch (e) { return toast(e.userMessage || e.message); }
  c = (c || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!c) return toast('Digite o código da sala');
  if (!c.startsWith('RISE-') && c.length === 6) c = 'RISE-' + c;
  S.name = requireDisplayName();
  if (!S.name) return;
  ls.set('rise_name', S.name);
  const joinBtn = $('#joinRoom'), inviteBtn = $('#joinInvite');
  joinBtn.disabled = true; joinBtn.textContent = 'Entrando...';
  if (inviteBtn) { inviteBtn.disabled = true; inviteBtn.textContent = 'Entrando...'; }
  try {
    const r = await roomPublic(c);
    if (!r) return toast('Sala não encontrada ou expirada');
    if (r.closed) return toast('Essa sala foi encerrada');

    // quem criou a sala neste navegador guarda o token de host
    S.hostToken = ls.get('rise_host_' + c);
    S.host = false;
    S.auth = {};
    if (S.hostToken) {
      const hash = await sha(S.hostToken);
      const test = await S.api.rpc('rise_is_host', { p_code: c, p_host_token_hash: hash });
      if (test.data === true) { S.host = true; S.auth = { host_token_hash: hash }; }
      else { S.hostToken = null; ls.remove('rise_host_' + c); }
    }

    if (r.locked && !S.host) return toast('A sala está trancada pelo host');
    if (r.password_required && !S.host) {
      const p = await askInput({ title: 'Sala protegida', label: 'Digite a senha da sala.', type: 'password', maxlength: 32, confirmText: 'Entrar' });
      if (p === null) return;
      const hash = await sha(p);
      const check = await S.api.rpc('rise_check_password', { p_code: c, p_password_hash: hash });
      if (check.error) throw new Error(check.error.message);
      if (!check.data) return toast('Senha incorreta');
      S.auth = { password_hash: hash };
    }

    S.code = c; S.room = r; S.shareAllowed = S.host;
    S.joinedAt = new Date().toISOString();
    history.replaceState({}, '', `${location.pathname}?room=${encodeURIComponent(c)}`);
    showApp(); await joinRealtime(); toast('Você entrou na sala');
  } catch (error) {
    console.error('Rise enterRoom:', error);
    toast(error?.userMessage || 'Erro ao entrar: ' + (error?.message || 'verifique sua conexão'));
  } finally {
    joinBtn.disabled = false; joinBtn.textContent = 'Entrar';
    if (inviteBtn) { inviteBtn.disabled = false; inviteBtn.textContent = 'Entrar na sala'; }
  }
}

export async function hostAction(action, value = null) {
  if (!S.host) return false;
  const { data, error } = await S.api.rpc('rise_host_action', {
    p_code: S.code, p_host_token_hash: await sha(S.hostToken), p_action: action, p_value: value
  });
  if (error || !data) { toast(error?.message || 'Falha na ação do host'); return false; }
  try { S.room = (await roomPublic(S.code)) || S.room; } catch { /* mantém o que tinha */ }
  setRoomUI();
  return true;
}

export function leave() {
  S._leaving = true;
  S.joined = false;
  clearRealtimeTimers();
  if (S._clockTimer) clearInterval(S._clockTimer);
  togglePeople(false);
  toggleTools(false);
  if (isFullscreen()) leaveFullscreenQuietly();
  syncFullscreenUI();
  if (S.stream) {
    send(null, 'stream-stopped', {});
    try { S.stream.getTracks().forEach(t => t.stop()); } catch { /* ignora */ }
    S.stream = null;
  }
  for (const [, pc] of S.peers) { try { pc.close(); } catch { /* ignora */ } }
  S.peers.clear(); S.remoteStreams.clear(); S.pendingIce.clear();
  if (S.channel) {
    const old = S.channel;
    S.channel = null;
    old.unsubscribe();
  }
  for (const t of S._leaveTimers.values()) clearTimeout(t);
  S._leaveTimers.clear();
  S.presence = {}; S.code = null; S.room = null; S.host = false; S.hostToken = null; S.auth = {};
  S.shareAllowed = false; S.joinedAt = null; S._lastTrack = null; S._joinAttempts = 0; S._replacing = false;
  S._stageSig = null;
  S._leaving = false;
  history.replaceState({}, '', location.pathname);
  showLanding();
  setRoomUI();
  conn(false, 'Desconectado');
}
