const express = require("express");
const app = express();
const http = require("http").Server(app);
const io = require("socket.io")(http, {
  cors: { origin: "*" }
});

let users = [];

io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);

  users.push(socket.id);
  if (users.length === 2) {
    users.forEach(id => {
      io.to(id).emit("ready");
    });
  }

  socket.on("offer", (data) => {
    socket.broadcast.emit("offer", data);
  });

  socket.on("answer", (data) => {
    socket.broadcast.emit("answer", data);
  });

  socket.on("candidate", (data) => {
    socket.broadcast.emit("candidate", data);
  });

  socket.on("leave", () => {
    users = users.filter(id => id !== socket.id);
    socket.broadcast.emit("leave");
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    users = users.filter(id => id !== socket.id);
    socket.broadcast.emit("leave");
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
