import express from "express";
import helmet from "helmet";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";

const app = express();
app.use(helmet());
app.use(cors({ origin: "*"}));
app.get("/", (_req,res)=>res.send("jusss-signal up"));
app.get("/status", (_req,res)=>res.json({ online: io?.engine?.clientsCount || 0, waiting: waiting.size }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*"},
  transports: ["websocket", "polling"],
  pingInterval: 20000,
  pingTimeout: 25000
});

// ---- Simple matcher -------------------------------------------------
/**
 * We keep a map from "wantKey" -> Set of sockets waiting.
 * wantKey is either the requested type (e.g. "Singer") or "ANY".
 * Each socket carries meta: { who, want, gender }
 */
const waiting = new Map(); // Map<string, Set<string>>
const meta = new Map();    // Map<socketId, {who,want,gender}>

function keyFor(want){ return want && want.trim() ? want.trim() : "ANY"; }

function enqueue(sock, m) {
  meta.set(sock.id, m);
  const k = keyFor(m.want);
  if (!waiting.has(k)) waiting.set(k, new Set());
  // Avoid duplicates
  for (const set of waiting.values()) set.delete(sock.id);
  waiting.get(k).add(sock.id);
  tryMatch();
}

function dequeue(sockId) {
  for (const set of waiting.values()) set.delete(sockId);
}

function tryMatch() {
  // Prefer exact wants first; then try cross-key matches against ANY
  for (const [k, set] of waiting) {
    while (set.size >= 2) {
      const [a,b] = [...set].slice(0,2);
      set.delete(a); set.delete(b);
      startPair(a,b, { reason:"same-key" });
    }
  }
  // Cross-match: one wants ANY, pair with someone from a specific key
  const anySet = waiting.get("ANY");
  if (!anySet || anySet.size === 0) return;

  for (const [k, set] of waiting) {
    if (k === "ANY" || set.size === 0) continue;
    while (anySet.size > 0 && set.size > 0) {
      const a = [...anySet][0];
      const b = [...set][0];
      anySet.delete(a); set.delete(b);
      startPair(a,b, { reason:"any-cross" });
    }
  }
}

function startPair(aId, bId, extra={}) {
  const a = io.sockets.sockets.get(aId);
  const b = io.sockets.sockets.get(bId);
  if (!a || !b) { dequeue(aId); dequeue(bId); return; }

  // Clear any residual queue state
  dequeue(aId); dequeue(bId);

  // Pick roles deterministically
  const caller = aId < bId ? a : b;
  const callee = aId < bId ? b : a;

  const aMeta = meta.get(aId) || {};
  const bMeta = meta.get(bId) || {};

  // Notify both sides with multiple event names (client listens to these)
  const payloadA = { id: (a===caller? bId:aId), partnerId: (a===caller? bId:aId), role: (a===caller? "caller":"callee"), peerId:(a===caller? bId:aId), ...extra };
  const payloadB = { id: (b===caller? aId:bId), partnerId: (b===caller? aId:bId), role: (b===caller? "caller":"callee"), peerId:(b===caller? aId:bId), ...extra };

  ["matched","pair","paired","match"].forEach(evt=>{
    a.emit(evt, payloadA);
    b.emit(evt, payloadB);
  });

  console.log("Paired:", aId, "<->", bId, extra.reason, "| who:", aMeta.who, "<->", bMeta.who, "| want:", aMeta.want, "<->", bMeta.want);
}

// ---- Socket wiring ---------------------------------------------------
io.on("connection", (socket) => {
  console.log("connected:", socket.id);

  const enqueueFrom = (data) => {
    const m = {
      who:   data?.who   || data?.meta?.who   || "Stranger",
      want:  data?.want  || data?.meta?.want  || "",
      gender:data?.gender|| data?.meta?.gender|| ""
    };
    enqueue(socket, m);
    socket.data.meta = m;
    socket.emit("queued", { ok:true, meta:m });
    console.log("queued:", socket.id, m);
  };

  // Accept all of these as “please find me a partner”
  ["joinQueue","ready","queue","findPartner"].forEach(evt => {
    socket.on(evt, enqueueFrom);
  });

  // Relay helpers: support multiple names and an envelope
  const relay = (fromEvtList, kind) => {
    fromEvtList.forEach(evt=>{
      socket.on(evt, (msg={})=>{
        const to = msg.to || msg.partnerId || msg.id || msg.peer || msg.peerId;
        if (!to) return;
        const target = io.sockets.sockets.get(to);
        if (!target) return;
        const payload = msg.sdp ? { sdp: msg.sdp } :
                        msg.answer ? { sdp: msg.answer } :
                        msg.offer ? { sdp: msg.offer } :
                        msg.candidate ? { candidate: msg.candidate } : msg;

        target.emit(kind, payload);
        // send cross aliases too
        if (kind === "offer")  target.emit("rtc:offer", payload);
        if (kind === "answer") target.emit("rtc:answer", payload);
        if (kind === "ice")    target.emit("rtc:candidate", payload);
        if (kind === "offer" || kind === "answer" || kind === "ice") {
          target.emit("signal", { ...payload, type: (kind==="ice"?"candidate":kind), to: to });
        }
      });
    });
  };

  relay(["offer","rtc:offer","signal_offer"], "offer");
  relay(["answer","rtc:answer","signal_answer"], "answer");
  relay(["ice","rtc:candidate","candidate"], "ice");

  // Generic envelope `{type, to, ...}`
  socket.on("signal", (msg={})=>{
    const to = msg.to;
    if (!to) return;
    const target = io.sockets.sockets.get(to);
    if (!target) return;
    target.emit(msg.type, msg);
    if (msg.type === "offer")  target.emit("rtc:offer", msg);
    if (msg.type === "answer") target.emit("rtc:answer", msg);
    if (msg.type === "candidate") target.emit("rtc:candidate", msg);
  });

  // Leave / end / partner-left
  ["leave","end","stop"].forEach(evt=>{
    socket.on(evt, (msg={})=>{
      const to = msg.to || msg.partnerId || msg.id || msg.peerId;
      if (to) {
        const target = io.sockets.sockets.get(to);
        if (target) ["partner-left","leave","ended"].forEach(e=>target.emit(e, { from: socket.id }));
      }
      // Put this socket back to queue if they didn’t press Stop
      if (evt !== "stop") {
        const m = socket.data.meta || { who:"Stranger", want:"", gender:"" };
        enqueue(socket, m);
      } else {
        dequeue(socket.id);
      }
    });
  });

  socket.on("disconnect", () => {
    console.log("disconnected:", socket.id);
    dequeue(socket.id);
    // notify potential partner if any (best-effort)
    socket.broadcast.emit("partner-left", { from: socket.id });
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("jusss-signal listening on", PORT));
