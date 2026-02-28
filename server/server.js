import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { MongoClient } from "mongodb";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const publicDir = path.join(__dirname, "..", "public");

app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "dashboard.html"));
});

app.use(express.static(publicDir, { index: false }));
app.use(express.json({ limit: "256kb" }));

app.get("/meeting", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

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
let meetingsCollection;
let analysesCollection;
let usersCollection;

async function connectMongo() {
  await mongoClient.connect();
  const db = mongoClient.db(MONGODB_DB);
  surveysCollection = db.collection("surveys");
  meetingsCollection = db.collection("meetings");
  analysesCollection = db.collection("analyses");
  usersCollection = db.collection("users");
  console.log("Connected to MongoDB");
}

function base64urlEncode(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64urlDecode(str) {
  const pad = str.length % 4;
  const padded = str + (pad ? "=".repeat(4 - pad) : "");
  const b64 = padded.replaceAll("-", "+").replaceAll("_", "/");
  return Buffer.from(b64, "base64");
}

function getAuthSecret() {
  return process.env.AUTH_SECRET || "2572468245824576235";
}

function signToken(payload) {
  const json = JSON.stringify(payload);
  const p = base64urlEncode(Buffer.from(json));
  const sig = crypto.createHmac("sha256", getAuthSecret()).update(p).digest();
  return `${p}.${base64urlEncode(sig)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const [p, s] = token.split(".");
  if (!p || !s) return null;

  const expected = base64urlEncode(crypto.createHmac("sha256", getAuthSecret()).update(p).digest());
  // constant-time compare
  const a = Buffer.from(expected);
  const b = Buffer.from(s);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(base64urlDecode(p).toString("utf8"));
    if (!payload?.uid) return null;
    return payload;
  } catch {
    return null;
  }
}

function getBearerToken(req) {
  const h = req.headers.authorization || "";
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function requireAuth(req, res, next) {
  const token = getBearerToken(req);
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: "Unauthorized" });
  req.user = { id: String(payload.uid), username: String(payload.uname || "") };
  next();
}

app.post("/api/auth/login", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    if (!username) return res.status(400).json({ error: "Missing username" });

    const existing = await usersCollection.findOne({ username });
    const userId = existing?._id
      ? String(existing._id)
      : String((await usersCollection.insertOne({ username, createdAt: now() })).insertedId);

    const token = signToken({ uid: userId, uname: username, iat: Date.now() });
    res.json({ token, user: { id: userId, username } });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Failed to login" });
  }
});

app.get("/api/auth/me", requireAuth, async (req, res) => {
  res.json({ user: req.user });
});

function now() {
  return new Date();
}

function computeEffectivenessScore(surveys) {
  if (!surveys || surveys.length === 0) return null;
  let n = 0;
  let sum = 0;
  for (const s of surveys) {
    const a = s?.answers || {};
    const vals = [a.overall, a.clarity, a.participation]
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v) && v >= 1 && v <= 5);
    if (vals.length === 3) {
      n += 1;
      sum += (vals[0] + vals[1] + vals[2]) / 3;
    }
  }
  if (n === 0) return null;
  const avg = sum / n; // 1..5
  return Math.round((avg / 5) * 100);
}

function simpleAiAnalyze(transcript) {
  const text = String(transcript || "").trim();
  if (!text) {
    return {
      summary: "No transcript provided.",
      suggestions: ["Upload or paste a transcript to generate insights."],
      model: "heuristic"
    };
  }

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const first = lines.slice(0, 8).join(" ");
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  const suggestions = [];
  if (wordCount > 1500) suggestions.push("Consider adding an agenda and timeboxing topics to keep the meeting focused.");
  if (/\b(action item|todo|follow[- ]?up)\b/i.test(text)) suggestions.push("Capture action items in a shared doc and confirm owners + due dates before ending.");
  if (/\b(off topic|sidetrack|tangent)\b/i.test(text)) suggestions.push("Use a parking-lot list for off-topic items so the core agenda stays on track.");
  if (suggestions.length === 0) suggestions.push("End with a quick recap: decisions made, next steps, and who owns each action item.");

  return {
    summary: `Transcript received (${wordCount} words). Key excerpt: ${first.slice(0, 280)}${first.length > 280 ? "…" : ""}`,
    suggestions,
    model: "heuristic"
  };
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

app.post("/api/meetings/start", requireAuth, async (req, res) => {
  try {
    const code = String(req.body?.code || "").trim().toUpperCase();
    const hostId = req.user.id;
    if (!code) return res.status(400).json({ error: "Missing code" });

    const existing = await meetingsCollection.findOne({ code });
    if (!existing) {
      await meetingsCollection.insertOne({
        code,
        hostId,
        startedAt: now(),
        endedAt: null,
        durationSeconds: null,
        maxParticipants: 1,
        createdAt: now(),
        updatedAt: now()
      });
    } else {
      await meetingsCollection.updateOne(
        { code },
        {
          $set: {
            hostId: hostId ?? existing.hostId ?? null,
            startedAt: existing.startedAt ?? now(),
            updatedAt: now()
          }
        }
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Meeting start error:", err);
    res.status(500).json({ error: "Failed to start meeting" });
  }
});

app.post("/api/meetings/end", async (req, res) => {
  try {
    const code = String(req.body?.code || "").trim().toUpperCase();
    if (!code) return res.status(400).json({ error: "Missing code" });

    const meeting = await meetingsCollection.findOne({ code });
    const endedAt = now();
    const startedAt = meeting?.startedAt ? new Date(meeting.startedAt) : null;
    const durationSeconds = startedAt ? Math.max(0, Math.round((endedAt - startedAt) / 1000)) : null;

    await meetingsCollection.updateOne(
      { code },
      {
        $set: {
          endedAt,
          durationSeconds,
          updatedAt: now()
        },
        $setOnInsert: { code, startedAt: startedAt || endedAt, createdAt: now() }
      },
      { upsert: true }
    );

    res.json({ success: true, endedAt, durationSeconds });
  } catch (err) {
    console.error("Meeting end error:", err);
    res.status(500).json({ error: "Failed to end meeting" });
  }
});

app.get("/api/meetings", requireAuth, async (req, res) => {
  try {
    const items = await meetingsCollection
      .find({ hostId: req.user.id }, { projection: { _id: 0 } })
      .sort({ startedAt: -1 })
      .limit(100)
      .toArray();
    res.json({ meetings: items });
  } catch (err) {
    console.error("Meetings list error:", err);
    res.status(500).json({ error: "Failed to list meetings" });
  }
});

app.get("/api/meetings/:code", requireAuth, async (req, res) => {
  try {
    const code = String(req.params.code || "").trim().toUpperCase();
    if (!code) return res.status(400).json({ error: "Missing code" });

    const meeting = await meetingsCollection.findOne({ code }, { projection: { _id: 0 } });
    if (!meeting) return res.status(404).json({ error: "Not found" });
    if (String(meeting.hostId || "") !== req.user.id) return res.status(403).json({ error: "Forbidden" });

    const surveys = await surveysCollection.find({ meetingCode: code }).toArray();
    const analysis = await analysesCollection.findOne({ code }, { projection: { _id: 0 } });

    const score = computeEffectivenessScore(surveys);
    const aggregates = {
      count: surveys.length,
      avgOverall: surveys.length ? Number((surveys.reduce((a, s) => a + (Number(s?.answers?.overall) || 0), 0) / surveys.length).toFixed(2)) : null,
      avgClarity: surveys.length ? Number((surveys.reduce((a, s) => a + (Number(s?.answers?.clarity) || 0), 0) / surveys.length).toFixed(2)) : null,
      avgParticipation: surveys.length ? Number((surveys.reduce((a, s) => a + (Number(s?.answers?.participation) || 0), 0) / surveys.length).toFixed(2)) : null,
      improve: surveys.map((s) => String(s?.answers?.improve || "").trim()).filter(Boolean),
      worked: surveys.map((s) => String(s?.answers?.worked || "").trim()).filter(Boolean)
    };

    res.json({ meeting, score, aggregates, analysis: analysis || null });
  } catch (err) {
    console.error("Meeting detail error:", err);
    res.status(500).json({ error: "Failed to load meeting" });
  }
});

app.post("/api/meetings/:code/transcript", requireAuth, async (req, res) => {
  try {
    const code = String(req.params.code || "").trim().toUpperCase();
    const transcript = String(req.body?.transcript || "");
    if (!code) return res.status(400).json({ error: "Missing code" });
    if (!transcript.trim()) return res.status(400).json({ error: "Missing transcript" });

    const meeting = await meetingsCollection.findOne({ code }, { projection: { _id: 0 } });
    if (!meeting) return res.status(404).json({ error: "Not found" });
    if (String(meeting.hostId || "") !== req.user.id) return res.status(403).json({ error: "Forbidden" });

    const result = simpleAiAnalyze(transcript);

    await analysesCollection.updateOne(
      { code },
      {
        $set: {
          code,
          transcriptPreview: transcript.trim().slice(0, 2000),
          summary: result.summary,
          suggestions: result.suggestions,
          model: result.model,
          updatedAt: now()
        },
        $setOnInsert: { createdAt: now() }
      },
      { upsert: true }
    );

    res.json({ success: true, summary: result.summary, suggestions: result.suggestions, model: result.model });
  } catch (err) {
    console.error("Transcript upload error:", err);
    res.status(500).json({ error: "Failed to analyze transcript" });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const rooms = new Map();
let nextId = 1;

function getRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      clients: new Map(),
      hostId: null,
      startedAt: null,
      maxParticipants: 0
    });
  }
  return rooms.get(code);
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

wss.on("connection", (ws) => {
  ws.clientId = String(nextId++);
  ws.roomCode = null;

  send(ws, { type: "hello", clientId: ws.clientId });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "join-room") {
      const code = String(msg.code || "").trim().toUpperCase();
      const role = String(msg.role || "join").trim();
      if (!code) return;

      ws.roomCode = code;
      ws.role = role;
      const room = getRoom(code);

      if (room.clients.size >= 10) {
        send(ws, { type: "room-full", max: 10 });
        return;
      }

      if (role === "host" && !room.hostId) {
        room.hostId = ws.clientId;
        room.startedAt = room.startedAt || now();
        meetingsCollection?.updateOne(
          { code },
          {
            $setOnInsert: {
              code,
              hostId: null,
              hostClientId: ws.clientId,
              startedAt: room.startedAt,
              endedAt: null,
              durationSeconds: null,
              maxParticipants: 1,
              createdAt: now()
            },
            $set: { updatedAt: now() }
          },
          { upsert: true }
        ).catch(() => {});
      }

      room.clients.set(ws.clientId, ws);
      room.maxParticipants = Math.max(room.maxParticipants, room.clients.size);
      meetingsCollection?.updateOne(
        { code },
        { $max: { maxParticipants: room.maxParticipants }, $set: { updatedAt: now() } },
        { upsert: true }
      ).catch(() => {});

      const members = Array.from(room.clients.keys()).filter((id) => id !== ws.clientId);

      send(ws, { type: "room-joined", room: code, members, hostId: room.hostId });

      for (const [id, peer] of room.clients) {
        if (id !== ws.clientId) send(peer, { type: "peer-joined", peerId: ws.clientId });
      }
      return;
    }

    if (msg.type === "end-meeting") {
      const code = ws.roomCode;
      if (!code) return;
      const room = rooms.get(code);
      if (!room) return;

      if (!room.hostId || ws.clientId !== room.hostId) {
        send(ws, { type: "not-host" });
        return;
      }

      const endedAt = now();
      const startedAt = room.startedAt ? new Date(room.startedAt) : null;
      const durationSeconds = startedAt ? Math.max(0, Math.round((endedAt - startedAt) / 1000)) : null;
      meetingsCollection?.updateOne(
        { code },
        {
          $set: { endedAt, durationSeconds, maxParticipants: room.maxParticipants, updatedAt: now() },
          $setOnInsert: { code, startedAt: startedAt || endedAt, createdAt: now() }
        },
        { upsert: true }
      ).catch(() => {});

      for (const [, peer] of room.clients) {
        send(peer, { type: "meeting-ended", code });
        try { peer.close(); } catch {}
      }

      rooms.delete(code);
      return;
    }

    if (msg.type === "signal") {
      const code = ws.roomCode;
      if (!code) return;

      const room = rooms.get(code);
      if (!room) return;

      const to = String(msg.to || "");
      const target = room.clients.get(to);
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

    room.clients.delete(ws.clientId);

    for (const [, peer] of room.clients) {
      send(peer, { type: "peer-left", peerId: ws.clientId });
    }

    if (room.clients.size === 0) rooms.delete(code);
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
