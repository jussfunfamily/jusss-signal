import express from "express";
import http from "http";
import cors from "cors";
import helmet from "helmet";
import { Server } from "socket.io";

const ORIGINS = (process.env.ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const app = express();
app.use(helmet());
app.use(cors({ origin: ORIGINS.length ? ORIGINS : true, credentials: true }));
app.get("/", (req, res) => res.send("Jusssmile signaling OK"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ORIGINS.length ? ORIGINS : true, methods: ["GET", "POST"] }
});

// ---- very small lobby/matching ----
const lobby = [];  // [{socketId, meta, ts}]
const rooms = new Map(); // roomId -> { a, b }

function bestMatchIndex(meta) {
  // exact type+gender+location
  let idx = lobby.findIndex(x =>
    (!meta.wantType     || x.meta.type     === meta.wantType) &&
    (!meta.wantGender   || x.meta.gender   === meta.wantGender) &&
    (!meta.wantLocation || x.meta.location === meta.wantLocation)
  );
  if (idx !== -1) return idx;

  // fallback: same type
  idx = lobby.findIndex(x => (!meta.wantType || x.meta.type === meta.wantType));
  if (idx !== -1) return idx;

  // fallback: anyone
  return lobby.length ? 0 : -1;
}

function makeRoom(a, b) {
  const roomId = `r_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
  rooms.set(roomId, { a: a.socketId, b: b.socketId });

  io.to(a.socketId).emit("match-found", {
    roomId,
    initiator: a.socketId,
    partnerMeta: b.meta
  });
  io.to(b.socketId).emit("match-found", {
    roomId,
    initiator: a.socketId, // same initiator id for both
    partnerMeta: a.meta
  });
}

io.on("connection", (socket) => {
  socket.on("join-queue", ({ meta, rematch }) => {
    socket.data.meta = meta || {};
    socket.data.roomId = null;

    const idx = bestMatchIndex(meta || {});
    if (idx >= 0) {
      const partner = lobby.splice(idx, 1)[0];
      makeRoom({ socketId: socket.id, meta }, partner);
    } else {
      lobby.push({ socketId: socket.id, meta, ts: Date.now() });
    }
  });

  socket.on("skip", ({ roomId }) => {
    const r = rooms.get(roomId);
    if (r) {
      const partnerId = (r.a === socket.id ? r.b : r.a);
      io.to(partnerId).emit("partner-left");
      rooms.delete(roomId);
    }
    const meta = socket.data.meta || {};
    const idx = bestMatchIndex(meta);
    if (idx >= 0) {
      const partner = lobby.splice(idx, 1)[0];
      makeRoom({ socketId: socket.id, meta }, partner);
    } else {
      lobby.push({ socketId: socket.id, meta, ts: Date.now() });
    }
  });

  socket.on("signal", ({ roomId, type, data }) => {
    const r = rooms.get(roomId);
    if (!r) return;
    const peer = (r.a === socket.id ? r.b : r.a);
    io.to(peer).emit("signal", { type, data });
  });

  socket.on("chat", ({ roomId, text }) => {
    const r = rooms.get(roomId);
    if (!r) return;
    const peer = (r.a === socket.id ? r.b : r.a);
    io.to(peer).emit("chat", { text });
  });

  socket.on("disconnect", () => {
    const i = lobby.findIndex(x => x.socketId === socket.id);
    if (i !== -1) lobby.splice(i, 1);
    for (const [roomId, r] of rooms.entries()) {
      if (r.a === socket.id || r.b === socket.id) {
        const peer = (r.a === socket.id ? r.b : r.a);
        io.to(peer).emit("partner-left");
        rooms.delete(roomId);
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log("Signaling on :" + PORT));
