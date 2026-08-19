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

// Envia apenas metadados da sala (participantes, host, qual vídeo está carregado).
// NÃO carrega informação de tempo/play-pause aqui — isso evita que a sala inteira
// seja "re-sincronizada" (e pareça reiniciar) toda vez que alguém entra ou sai.
function broadcastRoomState(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  io.to(roomId).emit('room-state', {
    videoId: room.videoId,
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

    // Manda pro recém-chegado o estado exato de reprodução ATUAL, uma única vez,
    // para ele sincronizar o player logo na criação (sem reiniciar o vídeo dos outros).
    socket.emit('joined', {
      youAreHost: room.hostId === socket.id,
      videoId: room.videoId,
      currentTime: room.currentTime,
      isPlaying: room.isPlaying
    });

    broadcastRoomState(roomId);
  });

  socket.on('set-video', ({ videoId }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room || socket.id !== room.hostId) return; // só o host troca o vídeo

    room.videoId = videoId;
    room.isPlaying = true;
    room.currentTime = 0;

    broadcastRoomState(roomId);
    io.to(roomId).emit('playback-update', { isPlaying: true, currentTime: 0 });
  });

  socket.on('playback', ({ isPlaying, currentTime }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room || socket.id !== room.hostId) return; // só o host controla play/pause/seek

    room.isPlaying = isPlaying;
    room.currentTime = currentTime;
    socket.to(roomId).emit('playback-update', { isPlaying, currentTime });
  });

  // Sincronização periódica de tempo (evita "drift" acumulado sem forçar play/pause).
  socket.on('time-sync', ({ currentTime }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room || socket.id !== room.hostId) return;

    room.currentTime = currentTime;
    socket.to(roomId).emit('time-update', { currentTime });
  });

  socket.on('visibility', ({ hidden }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room) return;

    const p = room.participants[socket.id];
    if (p) {
      p.status = hidden ? 'away' : 'watching';
      broadcastRoomState(roomId);
    }
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room) return;

    // Se quem saiu era o host, a sala é fechada para todo mundo.
    if (room.hostId === socket.id) {
      io.to(roomId).emit('room-closed');
      delete rooms[roomId];
      io.socketsLeave(roomId);
      return;
    }

    delete room.participants[socket.id];
    if (Object.keys(room.participants).length === 0) {
      delete rooms[roomId];
    } else {
      broadcastRoomState(roomId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
