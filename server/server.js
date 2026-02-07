import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { MongoClient } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const publicDir = path.join(__dirname, "..", "public");

app.use(express.static(publicDir));
app.use(express.json({ limit: "256kb" }));

app.get("/ice", (req, res) => {
  const iceServers = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:global.stun.twilio.com:3478" }
  ];

  const { TURN_URL, TURN_USERNAME, TURN_CREDENTIAL } = process.env;

  if (TURN_URL && TURN_USERNAME && TURN_CREDENTIAL) {
    iceServers.push({
      urls: TURN_URL,
      username: TURN_USERNAME,
      credential: TURN_CREDENTIAL
    });
  }

  res.json({ iceServers });
});

function requireEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const MONGODB_URI = requireEnv("MONGODB_URI");
const MONGODB_DB = process.env.MONGODB_DB || "meeting_analyzer";

const mongoClient = new MongoClient(MONGODB_URI);

let surveysCollection;

async function connectMongo() {
  await mongoClient.connect();
  const db = mongoClient.db(MONGODB_DB);
  surveysCollection = db.collection("surveys");
  console.log("Connected to MongoDB");
}

app.post("/api/surveys", async (req, res) => {
  try {
    const { meetingCode, respondentId, role, answers } = req.body;

    if (!meetingCode || !answers) {
      return res.status(400).json({ error: "Missing survey data" });
    }

    const result = await surveysCollection.insertOne({
      meetingCode: String(meetingCode).trim(),
      respondentId: respondentId ? String(respondentId).trim() : null,
      role: role ? String(role).trim() : null,
      answers,
      createdAt: new Date()
    });

    res.status(201).json({ success: true, id: result.insertedId });
  } catch (err) {
    console.error("Survey save error:", err);
    res.status(500).json({ error: "Failed to save survey" });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const rooms = new Map(); // roomCode -> Map(clientId -> ws)
let nextId = 1;

function getRoom(code) {
  if (!rooms.has(code)) rooms.set(code, new Map());
  return rooms.get(code);
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

wss.on("connection", (ws) => {
  ws.clientId = String(nextId++);
  ws.roomCode = null;

  // Tell client its id immediately
  send(ws, { type: "hello", clientId: ws.clientId });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "join-room") {
      const code = String(msg.code || "").trim();
      if (!code) return;

      ws.roomCode = code;
      const room = getRoom(code);

      // enforce max 10
      if (room.size >= 10) {
        send(ws, { type: "room-full", max: 10 });
        return;
      }

      room.set(ws.clientId, ws);

      // roster = everyone else already in room
      const members = Array.from(room.keys()).filter((id) => id !== ws.clientId);

      // send roster to new client
      send(ws, { type: "room-joined", room: code, members });

      // notify existing peers that someone joined
      for (const [id, peer] of room) {
        if (id !== ws.clientId) send(peer, { type: "peer-joined", peerId: ws.clientId });
      }
      return;
    }

    // relay signaling to a specific peer
    if (msg.type === "signal") {
      const code = ws.roomCode;
      if (!code) return;

      const room = rooms.get(code);
      if (!room) return;

      const to = String(msg.to || "");
      const target = room.get(to);
      if (!target) return;

      send(target, {
        type: "signal",
        from: ws.clientId,
        data: msg.data
      });
    }
  });

  ws.on("close", () => {
    const code = ws.roomCode;
    if (!code) return;

    const room = rooms.get(code);
    if (!room) return;

    room.delete(ws.clientId);

    // notify remaining peers
    for (const [, peer] of room) {
      send(peer, { type: "peer-left", peerId: ws.clientId });
    }

    if (room.size === 0) rooms.delete(code);
  });
});

const PORT = process.env.PORT || 5000;

(async () => {
  try {
    await connectMongo();
    server.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("Fatal startup error:", err);
    process.exit(1);
  }
})();
