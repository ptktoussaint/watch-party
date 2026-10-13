import { $ } from './state.js';

export function toast(t) {
  const e = $('#toast');
  if (!e) return;
  e.textContent = t;
  e.classList.remove('show');
  void e.offsetWidth;
  e.classList.add('show');
  clearTimeout(window._t);
  window._t = setTimeout(() => e.classList.remove('show'), 3200);
}

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function initials(n) {
  return String(n || '?').trim().split(/\s+/).slice(0, 2).map(x => x[0]).join('').toUpperCase() || '?';
}

export function avatarColor(name) {
  // Rampa de grafite (dois tons quentes no fim) — mantém pessoas distinguíveis
  // sem competir com o âmbar, que na UI significa estado ativo/permitido.
  const colors = ['#3A3F46', '#4C535B', '#5E666F', '#33383E', '#4A453C', '#6B7079', '#5C554A'];
  let h = 0;
  for (const c of String(name || '')) h = (h + c.charCodeAt(0)) % colors.length;
  return colors[h];
}

export async function sha(v) {
  if (!crypto.subtle) {
    throw Object.assign(new Error('HTTPS_REQUIRED'), {
      userMessage: 'Abra o site em HTTPS (não use http://IP). Sem HTTPS o navegador bloqueia a criptografia necessária para criar salas.'
    });
  }
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}

export function ensureApiReady() {
  if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    throw Object.assign(new Error('HTTPS_REQUIRED'), {
      userMessage: 'Use HTTPS para criar ou entrar em salas (ou acesse por localhost).'
    });
  }
}

/** RISE- + 6 caracteres sem ambiguidade, sorteados com fonte criptográfica. */
export function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return 'RISE-' + Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}

export async function copy(t, m = 'Copiado!') {
  try {
    await navigator.clipboard.writeText(t);
  } catch {
    const x = document.createElement('textarea');
    x.value = t;
    document.body.appendChild(x);
    x.select();
    document.execCommand('copy');
    x.remove();
  }
  toast(m);
}

export function conn(on, text) {
  const c = $('#conn');
  if (!c) return;
  c.classList.toggle('off', !on);
  const sp = c.querySelector('span');
  if (sp) sp.textContent = text;
}

export function openModal(node) {
  $('#modalBody').innerHTML = '';
  $('#modalBody').appendChild(node);
  $('#modalClose').onclick = closeModal;
  $('#modal').classList.add('show');
}

export function closeModal() {
  $('#modal').classList.remove('show');
}

/** Pergunta de uma linha no lugar do prompt() do navegador (que mostra a senha em texto puro). */
export function askInput({ title, label = '', type = 'text', value = '', maxlength = 80, confirmText = 'OK' }) {
  return new Promise(resolve => {
    const body = document.createElement('form');
    body.innerHTML = `<h2>${esc(title)}</h2>${label ? `<p>${esc(label)}</p>` : ''}`;
    const input = document.createElement('input');
    input.type = type;
    input.value = value;
    input.maxLength = maxlength;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.style.marginTop = '14px';
    input.setAttribute('aria-label', title);
    const actions = document.createElement('div');
    actions.className = 'modalActions';
    const ok = document.createElement('button');
    ok.className = 'btn btnPrimary';
    ok.type = 'submit';
    ok.textContent = confirmText;
    const cancel = document.createElement('button');
    cancel.className = 'btn btnQuiet';
    cancel.type = 'button';
    cancel.textContent = 'Cancelar';
    actions.append(ok, cancel);
    body.append(input, actions);

    const done = v => { closeModal(); resolve(v); };
    body.onsubmit = e => { e.preventDefault(); done(input.value); };
    cancel.onclick = () => done(null);
    openModal(body);
    $('#modalClose').onclick = () => done(null);
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

export function askConfirm({ title, text = '', confirmText = 'Confirmar', danger = false }) {
  return new Promise(resolve => {
    const body = document.createElement('div');
    body.innerHTML = `<h2>${esc(title)}</h2>${text ? `<p>${esc(text)}</p>` : ''}`;
    const actions = document.createElement('div');
    actions.className = 'modalActions';
    const ok = document.createElement('button');
    ok.className = 'btn ' + (danger ? 'btnDanger' : 'btnPrimary');
    ok.type = 'button';
    ok.textContent = confirmText;
    const cancel = document.createElement('button');
    cancel.className = 'btn btnQuiet';
    cancel.type = 'button';
    cancel.textContent = 'Cancelar';
    actions.append(ok, cancel);
    body.appendChild(actions);
    const done = v => { closeModal(); resolve(v); };
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
    openModal(body);
    $('#modalClose').onclick = () => done(false);
  });
}

export function leaveFullscreenQuietly() {
  const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
  try { exit?.call(document); } catch { /* ignora */ }
}

