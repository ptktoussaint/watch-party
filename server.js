const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Estado das salas em memória.
// rooms[roomId] = { hostId, videoId, isPlaying, currentTime, participants: { socketId: {id, name, status} } }
const rooms = {};

function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      hostId: null,
      videoId: null,
      isPlaying: false,
      currentTime: 0,
      participants: {}
    };
  }
  return rooms[roomId];
}

function broadcastState(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  io.to(roomId).emit('room-state', {
    videoId: room.videoId,
    isPlaying: room.isPlaying,
    currentTime: room.currentTime,
    hostId: room.hostId,
    participants: Object.values(room.participants)
  });
}

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, name }) => {
    if (!roomId || !name) return;
    roomId = String(roomId).trim().toLowerCase();
    name = String(name).trim().slice(0, 40);
    if (!roomId || !name) return;

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name = name;

    const room = getRoom(roomId);
    if (!room.hostId) room.hostId = socket.id;

    room.participants[socket.id] = { id: socket.id, name, status: 'watching' };

    socket.emit('joined', { youAreHost: room.hostId === socket.id });
    broadcastState(roomId);
  });

  socket.on('set-video', ({ videoId }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = getRoom(roomId);
    if (socket.id !== room.hostId) return; // só o host troca o vídeo
    room.videoId = videoId;
    room.isPlaying = true;
    room.currentTime = 0;
    broadcastState(roomId);
  });

  socket.on('playback', ({ isPlaying, currentTime }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = getRoom(roomId);
    if (socket.id !== room.hostId) return; // só o host controla play/pause/seek
    room.isPlaying = isPlaying;
    room.currentTime = currentTime;
    broadcastState(roomId);
  });

  socket.on('visibility', ({ hidden }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = getRoom(roomId);
    const p = room.participants[socket.id];
    if (p) {
      p.status = hidden ? 'away' : 'watching';
      broadcastState(roomId);
    }
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room) return;

    delete room.participants[socket.id];

    if (room.hostId === socket.id) {
      const remaining = Object.keys(room.participants);
      room.hostId = remaining.length ? remaining[0] : null;
    }

    if (Object.keys(room.participants).length === 0) {
      delete rooms[roomId];
    } else {
      broadcastState(roomId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
