// server.js — jusss-signal (pair anyone with anyone)
import express from "express";
import helmet from "helmet";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";

const app = express();
app.use(helmet());
app.use(cors({ origin: "*" }));

app.get("/", (_req, res) => res.send("jusss-signal up"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"],
  pingInterval: 20000,
  pingTimeout: 25000
});

/* ---------------- State ---------------- */
// Simple FIFO queue of socket IDs (anyone-with-anyone)
const queue = [];              // Array<string>
const meta  = new Map();       // Map<socketId, {who,want,gender}>

function inQueue(id) { return queue.includes(id); }
function enqueue(sock, m) {
  meta.set(sock.id, m);
  // remove if already present (avoid duplicates) then push to tail
  const idx = queue.indexOf(sock.id);
  if (idx !== -1) queue.splice(idx, 1);
  queue.push(sock.id);
  tryMatch();
}
function dequeue(id) {
  const idx = queue.indexOf(id);
  if (idx !== -1) queue.splice(idx, 1);
}

/* ---------------- Pairing ---------------- */
function tryMatch() {
  while (queue.length >= 2) {
    const aId = queue.shift();
    const bId = queue.shift();
    startPair(aId, bId, { reason: "any-any" });
  }
}

function startPair(aId, bId, extra = {}) {
  const a = io.sockets.sockets.get(aId);
  const b = io.sockets.sockets.get(bId);
  if (!a || !b) {
    if (a) enqueue(a, a.data?.meta || { who: "Stranger", want: "", gender: "" });
    if (b) enqueue(b, b.data?.meta || { who: "Stranger", want: "", gender: "" });
    return;
  }

  // Decide roles deterministically by socket id
  const caller = aId < bId ? a : b;
  const callee = aId < bId ? b : a;

  const payloadFor = (meIsCaller, partner) => ({
    id: partner.id,
    partnerId: partner.id,
    peerId: partner.id,
    role: meIsCaller ? "caller" : "callee",
    ...extra
  });

  const payloadA = payloadFor(a === caller, b);
  const payloadB = payloadFor(b === caller, a);

  ["matched", "pair", "paired", "match"].forEach(evt => {
    a.emit(evt, payloadA);
    b.emit(evt, payloadB);
  });

  const ma = meta.get(aId) || {};
  const mb = meta.get(bId) || {};
  console.log("Paired:", aId, "<->", bId, extra.reason, "| who:", ma.who, "<->", mb.who);
}

/* ---------------- Socket wiring ---------------- */
io.on("connection", (socket) => {
  console.log("connected:", socket.id);

  const enqueueFrom = (data = {}) => {
    const m = {
      who:    data?.who    ?? data?.meta?.who    ?? "Stranger",
      want:   data?.want   ?? data?.meta?.want   ?? "",
      gender: data?.gender ?? data?.meta?.gender ?? ""
    };
    socket.data.meta = m;
    enqueue(socket, m);
    socket.emit("queued", { ok: true, meta: m });
    console.log("queued:", socket.id, m, "| waiting:", queue.length);
  };

  // Join queue (accept many names)
  ["joinQueue", "ready", "queue", "findPartner"].forEach(evt =>
    socket.on(evt, enqueueFrom)
  );

  // Relay helpers (support multiple names and generic envelope)
  const relay = (fromEvents, outKind) => {
    fromEvents.forEach(evt => {
      socket.on(evt, (msg = {}) => {
        const to = msg.to || msg.partnerId || msg.id || msg.peer || msg.peerId;
        if (!to) return;
        const target = io.sockets.sockets.get(to);
        if (!target) return;

        const payload =
          msg.sdp ? { sdp: msg.sdp } :
          msg.answer ? { sdp: msg.answer } :
          msg.offer ? { sdp: msg.offer } :
          msg.candidate ? { candidate: msg.candidate } :
          msg;

        target.emit(outKind, payload);
        if (outKind === "offer")  target.emit("rtc:offer", payload);
        if (outKind === "answer") target.emit("rtc:answer", payload);
        if (outKind === "ice")    target.emit("rtc:candidate", payload);
        if (["offer","answer","ice"].includes(outKind)) {
          target.emit("signal", { ...payload, type: outKind === "ice" ? "candidate" : outKind, to });
        }
      });
    });
  };

  relay(["offer", "rtc:offer", "signal_offer"], "offer");
  relay(["answer", "rtc:answer", "signal_answer"], "answer");
  relay(["ice", "rtc:candidate", "candidate"], "ice");

  // Generic envelope `{type, to, ...}`
  socket.on("signal", (msg = {}) => {
    const to = msg.to;
    if (!to) return;
    const target = io.sockets.sockets.get(to);
    if (!target) return;
    target.emit(msg.type, msg);
    if (msg.type === "offer")     target.emit("rtc:offer", msg);
    if (msg.type === "answer")    target.emit("rtc:answer", msg);
    if (msg.type === "candidate") target.emit("rtc:candidate", msg);
  });

  // Leave / end / stop
  ["leave", "end", "stop"].forEach(evt => {
    socket.on(evt, (msg = {}) => {
      const to = msg.to || msg.partnerId || msg.id || msg.peerId;
      if (to) {
        const target = io.sockets.sockets.get(to);
        if (target) ["partner-left", "leave", "ended"].forEach(e =>
          target.emit(e, { from: socket.id })
        );
      }
      if (evt !== "stop") {
        // Back to the queue
        const m = socket.data.meta || { who: "Stranger", want: "", gender: "" };
        enqueue(socket, m);
      } else {
        // Stop = remove from queue
        dequeue(socket.id);
      }
    });
  });

  socket.on("disconnect", () => {
    console.log("disconnected:", socket.id);
    dequeue(socket.id);
    socket.broadcast.emit("partner-left", { from: socket.id });
  });
});

/* ---------------- Status endpoint ---------------- */
// accurate waiting count = queue length
app.get("/status", (_req, res) => {
  const online = io?.engine?.clientsCount || 0;
  res.json({ online, waiting: queue.length });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("jusss-signal listening on", PORT));
