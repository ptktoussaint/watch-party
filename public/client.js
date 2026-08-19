const joinScreen = document.getElementById('join-screen');
const roomScreen = document.getElementById('room-screen');
const joinForm = document.getElementById('join-form');
const nameInput = document.getElementById('name-input');
const roomInput = document.getElementById('room-input');
const roomNameDisplay = document.getElementById('room-name-display');
const participantList = document.getElementById('participant-list');
const participantCount = document.getElementById('participant-count');
const hostControls = document.getElementById('host-controls');
const noHostMsg = document.getElementById('no-host-msg');
const videoUrlInput = document.getElementById('video-url-input');
const loadVideoBtn = document.getElementById('load-video-btn');
const fullscreenBtn = document.getElementById('fullscreen-btn');

let socket = null;
let player = null;
let ytApiReady = false;
let playerReady = false;
let isHost = false;
let currentVideoId = null;
let pendingInitialState = null;
let applyingRemoteState = false; // evita re-emitir eventos que vieram do servidor
let timeSyncInterval = null;

// Preenche a sala automaticamente se veio na URL (?sala=xxx)
const params = new URLSearchParams(window.location.search);
const roomFromUrl = params.get('sala');
if (roomFromUrl) roomInput.value = roomFromUrl;

// --- YouTube IFrame API ---
function onYouTubeIframeAPIReady() {
  ytApiReady = true;
}
window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;

function extractYouTubeId(input) {
  input = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/live\/)([a-zA-Z0-9_-]{11})/
  ];
  for (const p of patterns) {
    const m = input.match(p);
    if (m) return m[1];
  }
  return null;
}

// videoId: id do vídeo a carregar
// initialState: { currentTime, isPlaying } | null — usado só na primeira criação do player,
// para o recém-chegado sincronizar direto na posição certa (sem reiniciar do zero).
function createPlayer(videoId, initialState) {
  currentVideoId = videoId;

  if (player) {
    playerReady = true; // player já existe e já está pronto
    applyingRemoteState = true;
    player.loadVideoById(videoId);
    setTimeout(() => { applyingRemoteState = false; }, 500);
    return;
  }

  playerReady = false;
  pendingInitialState = initialState || null;

  player = new YT.Player('player', {
    videoId: videoId,
    playerVars: {
      rel: 0,
      modestbranding: 1,
      fs: 0, // usamos nosso próprio botão de tela cheia
      controls: isHost ? 1 : 0,
      disablekb: isHost ? 0 : 1
    },
    events: {
      onReady: onPlayerReady,
      onStateChange: onPlayerStateChange
    }
  });
}

function onPlayerReady() {
  playerReady = true;
  if (pendingInitialState) {
    applyingRemoteState = true;
    if (pendingInitialState.currentTime > 0.5) {
      player.seekTo(pendingInitialState.currentTime, true);
    }
    if (pendingInitialState.isPlaying) player.playVideo();
    else player.pauseVideo();
    pendingInitialState = null;
    setTimeout(() => { applyingRemoteState = false; }, 600);
  }
}

function onPlayerStateChange(event) {
  if (applyingRemoteState) return; // mudança veio do servidor, não reenviar
  if (!isHost) return; // só o host manda updates de playback

  if (event.data === YT.PlayerState.PLAYING) {
    socket.emit('playback', { isPlaying: true, currentTime: player.getCurrentTime() });
  } else if (event.data === YT.PlayerState.PAUSED) {
    socket.emit('playback', { isPlaying: false, currentTime: player.getCurrentTime() });
  }
}

function startTimeSyncLoop() {
  stopTimeSyncLoop();
  timeSyncInterval = setInterval(() => {
    if (isHost && player && playerReady && typeof player.getCurrentTime === 'function') {
      socket.emit('time-sync', { currentTime: player.getCurrentTime() });
    }
  }, 4000);
}
function stopTimeSyncLoop() {
  if (timeSyncInterval) clearInterval(timeSyncInterval);
  timeSyncInterval = null;
}

function loadWhenApiReady(videoId, initialState) {
  const doCreate = () => createPlayer(videoId, initialState);
  if (ytApiReady) {
    doCreate();
  } else {
    const check = setInterval(() => {
      if (ytApiReady) { clearInterval(check); doCreate(); }
    }, 200);
  }
}

// --- Entrada na sala ---
joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  const roomId = roomInput.value.trim().toLowerCase();
  if (!name || !roomId) return;

  socket = io();

  socket.on('connect', () => {
    socket.emit('join-room', { roomId, name });
  });

  socket.on('joined', ({ youAreHost, videoId, currentTime, isPlaying }) => {
    isHost = youAreHost;
    hostControls.classList.toggle('hidden', !isHost);
    joinScreen.classList.add('hidden');
    roomScreen.classList.remove('hidden');
    roomNameDisplay.textContent = roomId;

    startTimeSyncLoop();

    if (videoId) {
      noHostMsg.classList.add('hidden');
      loadWhenApiReady(videoId, { currentTime, isPlaying });
    } else {
      noHostMsg.classList.toggle('hidden', isHost);
    }
  });

  socket.on('room-state', (state) => {
    renderParticipants(state.participants, state.hostId);

    if (state.videoId && state.videoId !== currentVideoId) {
      // Vídeo novo (host trocou) — carrega do zero, isso é intencional.
      noHostMsg.classList.add('hidden');
      loadWhenApiReady(state.videoId, null);
    } else if (!state.videoId) {
      noHostMsg.classList.toggle('hidden', isHost);
    }
  });

  // Comando explícito do host: play / pause / troca de vídeo.
  socket.on('playback-update', ({ isPlaying, currentTime }) => {
    if (!player || !playerReady) return;
    applyingRemoteState = true;
    const drift = Math.abs(player.getCurrentTime() - currentTime);
    if (drift > 1.5) player.seekTo(currentTime, true);
    if (isPlaying) player.playVideo();
    else player.pauseVideo();
    setTimeout(() => { applyingRemoteState = false; }, 500);
  });

  // Correção suave de posição (sem mexer em play/pause) — evita "pulos" perceptíveis.
  socket.on('time-update', ({ currentTime }) => {
    if (!player || !playerReady || applyingRemoteState) return;
    const drift = Math.abs(player.getCurrentTime() - currentTime);
    if (drift > 3) {
      applyingRemoteState = true;
      player.seekTo(currentTime, true);
      setTimeout(() => { applyingRemoteState = false; }, 500);
    }
  });

  socket.on('room-closed', () => {
    stopTimeSyncLoop();
    alert('O host fechou a sala.');
    window.location.href = window.location.pathname;
  });
});

// --- Host: carregar vídeo ---
loadVideoBtn.addEventListener('click', () => {
  const id = extractYouTubeId(videoUrlInput.value);
  if (!id) {
    alert('Não consegui reconhecer esse link do YouTube. Cole a URL completa do vídeo.');
    return;
  }
  socket.emit('set-video', { videoId: id });
});

// --- Tela cheia (disponível para todos) ---
fullscreenBtn.addEventListener('click', () => {
  if (!player || typeof player.getIframe !== 'function') return;
  const iframe = player.getIframe();
  if (iframe.requestFullscreen) iframe.requestFullscreen();
  else if (iframe.webkitRequestFullscreen) iframe.webkitRequestFullscreen();
  else if (iframe.mozRequestFullScreen) iframe.mozRequestFullScreen();
  else if (iframe.msRequestFullscreen) iframe.msRequestFullscreen();
});

// --- Lista de participantes ---
function renderParticipants(participants, hostId) {
  participantCount.textContent = participants.length;
  participantList.innerHTML = '';
  participants.forEach((p) => {
    const li = document.createElement('li');
    const statusClass = p.status === 'watching' ? 'status-watching' : 'status-away';
    const statusLabel = p.status === 'watching' ? 'Assistindo' : 'Ausente';
    const hostTag = p.id === hostId ? '<span class="host-tag">HOST</span>' : '';
    li.innerHTML = `<span>${escapeHtml(p.name)}${hostTag}</span><span class="status-badge ${statusClass}">${statusLabel}</span>`;
    participantList.appendChild(li);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Detecção de presença (troca de aba / minimizar) ---
// Isso NUNCA mexe no player — só avisa o servidor do status, que atualiza a lista
// de participantes. O vídeo continua de onde estava.
document.addEventListener('visibilitychange', () => {
  if (!socket) return;
  socket.emit('visibility', { hidden: document.hidden });
});
