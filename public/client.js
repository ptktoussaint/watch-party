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

let socket = null;
let player = null;
let ytApiReady = false;
let isHost = false;
let currentVideoId = null;
let mySocketId = null;
let applyingRemoteState = false; // evita re-emitir eventos que vieram do servidor

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
  // já é um ID puro (11 caracteres)
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

function createPlayer(videoId) {
  if (player) {
    player.loadVideoById(videoId);
    return;
  }
  player = new YT.Player('player', {
    videoId: videoId,
    playerVars: { rel: 0, modestbranding: 1 },
    events: {
      onStateChange: onPlayerStateChange
    }
  });
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

// --- Entrada na sala ---
joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  const roomId = roomInput.value.trim().toLowerCase();
  if (!name || !roomId) return;

  socket = io();
  mySocketId = null;

  socket.on('connect', () => {
    socket.emit('join-room', { roomId, name });
  });

  socket.on('joined', ({ youAreHost }) => {
    isHost = youAreHost;
    hostControls.classList.toggle('hidden', !isHost);
    joinScreen.classList.add('hidden');
    roomScreen.classList.remove('hidden');
    roomNameDisplay.textContent = roomId;
  });

  socket.on('room-state', (state) => {
    renderParticipants(state.participants, state.hostId);

    if (state.videoId) {
      noHostMsg.classList.add('hidden');
      if (state.videoId !== currentVideoId) {
        currentVideoId = state.videoId;
        if (ytApiReady) createPlayer(state.videoId);
        else {
          const check = setInterval(() => {
            if (ytApiReady) { clearInterval(check); createPlayer(state.videoId); }
          }, 200);
        }
      } else if (player && player.getCurrentTime) {
        applyingRemoteState = true;
        const drift = Math.abs(player.getCurrentTime() - state.currentTime);
        if (drift > 2) player.seekTo(state.currentTime, true);
        if (state.isPlaying) player.playVideo(); else player.pauseVideo();
        setTimeout(() => { applyingRemoteState = false; }, 300);
      }
    } else {
      noHostMsg.classList.toggle('hidden', isHost);
    }
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
document.addEventListener('visibilitychange', () => {
  if (!socket) return;
  socket.emit('visibility', { hidden: document.hidden });
});
