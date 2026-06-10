const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/api/ice-servers', async (req, res) => {
  const appName = process.env.METERED_APP_NAME;
  const apiKey  = process.env.METERED_API_KEY;

  if (appName && apiKey) {
    try {
      const meteredRes = await fetch(
        `https://${appName}.metered.ca/api/v1/turn/credentials?apiKey=${apiKey}`
      );
      const iceServers = await meteredRes.json();
      return res.json({ iceServers });
    } catch (err) {
      console.error('Metered TURN fetch failed, falling back to STUN:', err.message);
    }
  }

  // Fallback: public STUN only (no relay — may fail on strict NAT/mobile)
  res.json({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  });
});

app.use(express.static('public'));

// ---------- Game state (in memory) ----------
const rooms = {};  // { roomId: { players: [], names: {}, moves: {}, darePreferences: {}, ready: {} } }

// ---------- Dare list ----------
const dareList = [
  "Do 10 push-ups",
  "Remove one piece of clothing right now, your choice which one.",
  "Answer any question I ask truthfully while showing me the body part I choose.",
  "Sing a song for 30 seconds",
  "Record a 20-second moan and dirty talk voice note",
  "Talk in your mother tongue for the next round",
  "Show your environment",
  "reveal your darkest fantancy",
  "sing Your full national anthem",
  "find a random person and give a sugestive comment",
  "Go to the window or balcony and Quickly flash your tits on camera",
  "Change into whatever outfit I tell you to wear for the rest of the game.",
  "Do your best impression of a celebrity",
  "Tell a joke — opponent rates it out of 10",
  "Hop on one foot for 20 seconds",
];

// ---------- Helpers ----------
function generateRoomCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

const winMap = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

function decideWinner(moveA, moveB) {
  if (moveA === moveB) return 'draw';
  return winMap[moveA] === moveB ? 'playerA' : 'playerB';
}

// ---------- Socket.IO logic ----------
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // ----- Create room -----
  socket.on('create-room', (playerName) => {
    const roomId = generateRoomCode();
    rooms[roomId] = {
      players: [socket.id],
      names: { [socket.id]: playerName },
      moves: {},
      darePreferences: {},   // <-- per‑player toggle
      ready: {}
    };
    socket.join(roomId);
    socket.roomId = roomId;
    socket.emit('room-created', roomId);
    socket.emit('player-joined', { name: playerName, isYou: true });
    socket.emit('opponent-status', { connected: false });
    console.log(`Room ${roomId} created by ${playerName}`);
  });
  
  // ----- Peer ID exchange -----
socket.on('peer-id', (peerId) => {
  const roomId = socket.roomId;
  if (roomId && rooms[roomId]) {
    // Send the peer ID to everyone else in the room (the opponent)
    socket.to(roomId).emit('peer-id', peerId);
  }
});

  // ----- Join room -----
  socket.on('join-room', ({ roomId, playerName }) => {
    roomId = roomId.toUpperCase();
    const room = rooms[roomId];
    if (!room) {
      socket.emit('error', 'Room not found');
      return;
    }
    if (room.players.length >= 2) {
      socket.emit('error', 'Room is full');
      return;
    }
    room.players.push(socket.id);
    room.names[socket.id] = playerName;
    socket.emit('room-joined', roomId);
    socket.join(roomId);
    socket.roomId = roomId;

    socket.emit('player-joined', { name: playerName, isYou: true });
    const opponentId = room.players[0];
    socket.emit('opponent-joined', room.names[opponentId]);
    socket.to(roomId).emit('opponent-joined', playerName);
    io.to(roomId).emit('opponent-status', { connected: true });

    startRound(roomId);
  });

  // ----- Move selected -----
  socket.on('choose-move', (move) => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    if (room.moves[socket.id]) return;

    room.moves[socket.id] = move;
    socket.emit('move-accepted', move);

    if (Object.keys(room.moves).length === 2) {
      resolveRound(roomId);
    } else {
      socket.to(roomId).emit('opponent-moved');
    }
  });

  // ----- Dare mode toggle (per‑player) -----
  socket.on('toggle-dare-mode', (isActive) => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    rooms[roomId].darePreferences[socket.id] = isActive;
  });

  // ----- Ready for next round -----
  socket.on('ready-next', () => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    room.ready[socket.id] = true;
    io.to(roomId).emit('ready-update', {
      ready: Object.keys(room.ready).length,
      total: 2
    });
    if (Object.keys(room.ready).length === 2) {
      room.moves = {};
      room.ready = {};
      io.to(roomId).emit('round-start');
      startRound(roomId);
    }
  });

  // ----- Leave room -----
  socket.on('leave-room', () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      const room = rooms[roomId];
      const leaverName = room.names[socket.id];
      // Remove the player from the room
      room.players = room.players.filter(id => id !== socket.id);
      delete room.names[socket.id];
      delete room.darePreferences[socket.id];
      if (room.players.length === 0) {
        delete rooms[roomId];
      } else {
        // Tell the remaining player
        io.to(roomId).emit('player-left', leaverName);
        io.to(roomId).emit('opponent-status', { connected: false });
        room.moves = {};
        room.ready = {};
      }
      socket.leave(roomId);
      socket.roomId = null;
      console.log(`User ${socket.id} left room ${roomId}`);
    }
  });

  // ----- Disconnect -----
  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      const room = rooms[roomId];
      const leaverName = room.names[socket.id];
      room.players = room.players.filter(id => id !== socket.id);
      delete room.names[socket.id];
      delete room.darePreferences[socket.id];
      if (room.players.length === 0) {
        delete rooms[roomId];
      } else {
        io.to(roomId).emit('player-left', leaverName);
        io.to(roomId).emit('opponent-status', { connected: false });
        room.moves = {};
        room.ready = {};
      }
      console.log(`User ${socket.id} disconnected from room ${roomId}`);
    }
  });
});

// ---------- Round helpers ----------
function startRound(roomId) {
  const room = rooms[roomId];
  if (!room || room.players.length < 2) return;
  room.moves = {};
  room.ready = {};
  io.to(roomId).emit('round-start');
}

function resolveRound(roomId) {
  const room = rooms[roomId];
  const [p1, p2] = room.players;
  const moveP1 = room.moves[p1];
  const moveP2 = room.moves[p2];

  const result = decideWinner(moveP1, moveP2);
  const winnerId = result === 'playerA' ? p1 : (result === 'playerB' ? p2 : null);
  const isDraw = result === 'draw';

  // Use winner's dare preference (per‑player)
  const winnerPref = winnerId ? (room.darePreferences[winnerId] === true) : false;
  let dareText = null;
  if (!isDraw && winnerPref) {
    const randomIndex = Math.floor(Math.random() * dareList.length);
    dareText = dareList[randomIndex];
  }

  const baseData = {
    isDraw,
    dareMode: winnerPref,         // true = random, false = verbal
    dareText,
    winnerName: winnerId ? room.names[winnerId] : null
  };

  io.to(p1).emit('round-result', {
    ...baseData,
    yourMove: moveP1,
    opponentMove: moveP2,
    isWinner: winnerId === p1
  });

  io.to(p2).emit('round-result', {
    ...baseData,
    yourMove: moveP2,
    opponentMove: moveP1,
    isWinner: winnerId === p2
  });
}

// ---------- Start server ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});