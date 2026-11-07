const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 10000;

// ==========================================
// ESTADO DAS SALAS
// ==========================================
const rooms = {};

function createRoom(roomId, mode) {
  return {
    id: roomId,
    mode: mode || 'pvp',
    players: {},          // socketId -> playerState
    bots: [],             // lista de bots
    glooWalls: [],        // paredes de gelo
    groundWeapons: [],    // armas no chão
    powerups: [],         // power-ups
    createdAt: Date.now()
  };
}

// ==========================================
// CRIA BOTS (padrão para todas as salas)
// ==========================================
function spawnBots(roomId) {
  const bots = [];
  const botCount = 3;
  for (let i = 0; i < botCount; i++) {
    bots.push({
      id: `bot_${roomId}_${i}`,
      type: 'bot',
      health: 100,
      alive: true,
      x: Math.random() * 60 - 30,
      z: Math.random() * 60 - 30,
      yaw: Math.random() * Math.PI * 2,
      name: `Bot ${i + 1}`
    });
  }
  return bots;
}

// ==========================================
// ESTADO DO JOGADOR
// ==========================================
function createPlayerState(socket, data) {
  return {
    id: socket.id,
    name: data.username || 'Jogador',
    skin: data.skin || 'Default',
    health: 100,
    alive: true,
    x: 0, z: 0, yaw: 0,
    currentWeapon: null,
    kills: 0,
    streak: 0
  };
}

// ==========================================
// CONEXÃO
// ==========================================
io.on('connection', (socket) => {
  console.log('Conectado:', socket.id);

  // -------- ENTRAR NA SALA --------
  socket.on('joinRoom', (data) => {
    const { roomId, username, skin, mode } = data;
    socket.join(roomId);

    if (!rooms[roomId]) {
      rooms[roomId] = createRoom(roomId, mode);
      rooms[roomId].bots = spawnBots(roomId);
    }

    const room = rooms[roomId];
    const playerState = createPlayerState(socket, { username, skin });
    room.players[socket.id] = playerState;

    // Envia o estado COMPLETO da sala (tudo que o cliente precisa ver)
    socket.emit('roomState', {
      id: room.id,
      mode: room.mode,
      players: room.players,
      bots: room.bots,
      glooWalls: room.glooWalls,
      groundWeapons: room.groundWeapons,
      powerups: room.powerups
    });

    // Avisa todos que um novo jogador entrou
    socket.to(roomId).emit('playerJoined', playerState);

    console.log(`${username} entrou na sala ${roomId}. Jogadores: ${Object.keys(room.players).length}`);
  });

  // -------- MOVIMENTO --------
  socket.on('move', (data) => {
    const roomId = findRoomOfPlayer(socket.id);
    if (!roomId) return;
    const p = rooms[roomId].players[socket.id];
    if (!p) return;

    p.x = data.x;
    p.z = data.z;
    p.yaw = data.yaw;

    socket.to(roomId).emit('playerMoved', {
      id: socket.id,
      data: { x: data.x, z: data.z, yaw: data.yaw }
    });
  });

  // -------- TROCA DE ARMA --------
  socket.on('switchWeapon', (weaponType) => {
    const roomId = findRoomOfPlayer(socket.id);
    if (!roomId) return;
    const p = rooms[roomId].players[socket.id];
    if (!p) return;

    p.currentWeapon = weaponType;
    socket.to(roomId).emit('playerSwitchedWeapon', {
      id: socket.id,
      weapon: weaponType
    });
  });

  // -------- TIRO (AUTORITATIVO) --------
  socket.on('shoot', (data) => {
    const roomId = findRoomOfPlayer(socket.id);
    if (!roomId) return;
    const room = rooms[roomId];
    const p = room.players[socket.id];
    if (!p || !p.alive) return;

    const damage = data.damage || 25;

    // Acertou um bot
    if (data.targetType === 'bot' && data.targetId) {
      const bot = room.bots.find(b => b.id === data.targetId);
      if (bot && bot.alive) {
        bot.health -= damage;
        if (bot.health <= 0) {
          bot.alive = false;
          bot.health = 0;
          p.kills++;
          p.streak++;
          io.to(roomId).emit('botKilled', {
            targetId: bot.id,
            killerId: socket.id,
            newKills: p.kills,
            streak: p.streak
          });
        } else {
          io.to(roomId).emit('botHit', { id: bot.id, health: bot.health });
        }
      }
    }

    // Acertou outro jogador
    if (data.targetType === 'player' && data.targetId) {
      const target = room.players[data.targetId];
      if (target && target.alive) {
        target.health -= damage;
        if (target.health <= 0) {
          target.alive = false;
          target.health = 0;
          p.kills++;
          p.streak++;
          io.to(roomId).emit('playerDied', {
            id: target.id,
            killerId: socket.id,
            killerName: p.name
          });
          io.to(roomId).emit('killsUpdate', { id: socket.id, kills: p.kills });
        } else {
          io.to(roomId).emit('playerHit', { id: target.id, health: target.health });
        }
      }
    }
  });

  // -------- GELO (GLOO WALL) --------
  socket.on('spawnGloo', (wallData) => {
    const roomId = findRoomOfPlayer(socket.id);
    if (!roomId) return;
    const room = rooms[roomId];

    room.glooWalls.push(wallData);
    io.to(roomId).emit('glooCreated', wallData);
  });

  // -------- BOT ATACA JOGADOR --------
  socket.on('botAttack', (data) => {
    const roomId = findRoomOfPlayer(socket.id);
    if (!roomId) return;
    const room = rooms[roomId];
    const target = room.players[data.playerId];
    if (!target || !target.alive) return;

    const damage = 10;
    target.health -= damage;
    if (target.health <= 0) {
      target.alive = false;
      target.health = 0;
      io.to(roomId).emit('playerDied', {
        id: target.id,
        killerId: data.botId,
        killerName: 'Bot'
      });
      io.to(roomId).emit('gameOver');
    } else {
      io.to(roomId).emit('playerHit', { id: target.id, health: target.health });
    }
  });

  // -------- DESCONEXÃO --------
  socket.on('disconnect', () => {
    const roomId = findRoomOfPlayer(socket.id);
    if (roomId && rooms[roomId]) {
      delete rooms[roomId].players[socket.id];
      socket.to(roomId).emit('playerLeft', socket.id);
      if (Object.keys(rooms[roomId].players).length === 0) {
        delete rooms[roomId];
        console.log(`Sala ${roomId} deletada (vazia)`);
      }
    }
    console.log('Desconectado:', socket.id);
  });
});

function findRoomOfPlayer(socketId) {
  for (const roomId in rooms) {
    if (rooms[roomId].players[socketId]) return roomId;
  }
  return null;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
