// ====== server.js (Jusssmile Signaling Server) ======
const express = require('express');
const http = require('http');
const cors = require('cors');
const socketIO = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: { origin: '*' }
});

app.get('/', (req, res) => res.send("Your service is live 🎉"));

let waitingUsers = [];

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('join', (userData) => {
    socket.userData = userData;
    tryPairing(socket);
  });

  socket.on('signal', (data) => {
    const target = io.sockets.sockets.get(data.to);
    if (target) {
      target.emit('signal', {
        from: socket.id,
        signal: data.signal
      });
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    removeFromQueue(socket);
    if (socket.partner) {
      const partner = io.sockets.sockets.get(socket.partner);
      if (partner) {
        partner.emit('partner-left');
        partner.partner = null;
      }
    }
  });

  socket.on('next', () => {
    if (socket.partner) {
      const partner = io.sockets.sockets.get(socket.partner);
      if (partner) {
        partner.emit('partner-left');
        partner.partner = null;
      }
      socket.partner = null;
    }
    tryPairing(socket);
  });
});

function tryPairing(socket) {
  if (waitingUsers.length > 0) {
    const partner = waitingUsers.shift();

    if (partner.id === socket.id) {
      waitingUsers.push(socket);
      return;
    }

    socket.partner = partner.id;
    partner.partner = socket.id;

    socket.emit('partner-found', {
      id: partner.id,
      type: partner.userData?.type || 'Stranger',
      gender: partner.userData?.gender || 'Unknown',
      location: partner.userData?.location || 'Unknown'
    });

    partner.emit('partner-found', {
      id: socket.id,
      type: socket.userData?.type || 'Stranger',
      gender: socket.userData?.gender || 'Unknown',
      location: socket.userData?.location || 'Unknown'
    });

  } else {
    waitingUsers.push(socket);
  }
}

function removeFromQueue(socket) {
  waitingUsers = waitingUsers.filter(s => s.id !== socket.id);
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`✅ Jusssmile signaling server running on port ${PORT}`);
});
