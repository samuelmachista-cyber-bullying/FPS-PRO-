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
const rooms = {};

function findRoomOfPlayer(socketId) {
  for (const roomId in rooms) {
    if (rooms[roomId].players[socketId]) return roomId;
  }
  return null;
}

// Função que encerra a partida
function endMatch(roomId, winnerName = null) {
  const room = rooms[roomId];
  if (!room || room.ended) return;
  
  room.ended = true;
  clearTimeout(room.timeout);
  clearTimeout(room.matchTimer);

  let winnerId = null;
  if (winnerName) {
    for (const id in room.players) {
      if (room.players[id].name === winnerName) { winnerId = id; break; }
    }
  } else {
    // Se não tem vencedor (tempo esgotado), pega quem tem mais kills
    let maxKills = -1;
    for (const id in room.players) {
      if (room.players[id].kills > maxKills) {
        maxKills = room.players[id].kills;
        winnerId = id;
      }
    }
  }

  io.to(roomId).emit('gameOver', {
    winnerId: winnerId,
    winnerName: winnerName || (winnerId ? room.players[winnerId].name : 'Empate')
  });

  // Limpa a sala após enviar a mensagem
  setTimeout(() => { delete rooms[roomId]; }, 2000);
}

io.on('connection', (socket) => {
  socket.on('joinRoom', (data) => {
    const { roomId, username, skin, mode } = data;
    socket.join(roomId);

    if (!rooms[roomId]) {
      // Cria a sala nova
      rooms[roomId] = {
        id: roomId,
        players: {},
        glooWalls: [],
        ended: false
      };

      // Timer de 30s para o amigo entrar
      rooms[roomId].timeout = setTimeout(() => {
        if (Object.keys(rooms[roomId].players).length < 2) {
          io.to(roomId).emit('roomCancelled', { reason: 'O amigo não entrou a tempo.' });
          delete rooms[roomId];
        }
      }, 30000); // 30 segundos
    }

    const room = rooms[roomId];
    if (room.ended) return; // Se a partida já acabou, ignora

    // Adiciona o jogador
    room.players[socket.id] = {
      id: socket.id,
      name: username || 'Jogador',
      skin: skin || 'Default',
      health: 100,
      alive: true,
      x: 0, z: 0, yaw: 0,
      kills: 0
    };

    // Se já tem 2 jogadores, inicia o cronômetro de 2 minutos
    if (Object.keys(room.players).length === 2) {
      clearTimeout(room.timeout);
      
      // Avisa que a partida começou e envia o estado
      io.to(roomId).emit('matchStarted');
      
      // Define o fim da partida em 2 minutos
      room.matchTimer = setTimeout(() => {
        endMatch(roomId, null); // null = tempo esgotado
      }, 120000); // 120.000 ms = 2 minutos
    }

    // Manda o estado atual para o jogador novo e avisa os outros
    socket.emit('roomState', room);
    socket.to(roomId).emit('playerJoined', room.players[socket.id]);
  });

  // Movimentação
  socket.on('move', (data) => {
    const roomId = findRoomOfPlayer(socket.id);
    if (!roomId || rooms[roomId].ended) return;
    
    const p = rooms[roomId].players[socket.id];
    if (!p) return;
    p.x = data.x; p.z = data.z; p.yaw = data.yaw;

    socket.to(roomId).emit('playerMoved', { id: socket.id, data });
  });

  // Tiro
  socket.on('shoot', (data) => {
    const roomId = findRoomOfPlayer(socket.id);
    if (!roomId || rooms[roomId].ended) return;
    
    const room = rooms[roomId];
    const shooter = room.players[socket.id];
    if (!shooter || !shooter.alive) return;

    const target = room.players[data.targetId];
    if (target && target.alive) {
      target.health -= data.damage;
      
      if (target.health <= 0) {
        target.alive = false;
        target.health = 0;
        shooter.kills++;
        
        io.to(roomId).emit('playerDied', { id: target.id, killerId: socket.id, killerName: shooter.name });
        io.to(roomId).emit('killsUpdate', { id: socket.id, kills: shooter.kills });

        // Verifica se a partida deve acabar (só sobrou 1 vivo)
        let aliveCount = 0;
        let lastAlive = null;
        for (const id in room.players) {
          if (room.players[id].alive) { aliveCount++; lastAlive = room.players[id].name; }
        }
        
        if (aliveCount <= 1) {
          endMatch(roomId, lastAlive); // O último vivo ganha
        }
      } else {
        io.to(roomId).emit('playerHit', { id: target.id, health: target.health });
      }
    }
  });

  // Gelo
  socket.on('spawnGloo', (wallData) => {
    const roomId = findRoomOfPlayer(socket.id);
    if (!roomId || rooms[roomId].ended) return;
    rooms[roomId].glooWalls.push(wallData);
    io.to(roomId).emit('glooCreated', wallData);
  });

  // Desconexão
  socket.on('disconnect', () => {
    const roomId = findRoomOfPlayer(socket.id);
    if (roomId && rooms[roomId]) {
      delete rooms[roomId].players[socket.id];
      
      // Se sobrou só 1 jogador na sala após desconexão, ele ganha
      const remaining = Object.keys(rooms[roomId].players);
      if (remaining.length === 1) {
        endMatch(roomId, rooms[roomId].players[remaining[0]].name);
      } else if (remaining.length === 0) {
        delete rooms[roomId];
      }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
