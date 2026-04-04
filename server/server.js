import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { MongoClient } from "mongodb";
import dotenv from "dotenv";
import crypto from "crypto";
import { aiAnalyzeTranscript } from "./transcriptAnalyzer.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const publicDir = path.join(__dirname, "..", "public");

app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "dashboard.html"));
});

app.get("/sign-in", (req, res) => {
  res.sendFile(path.join(publicDir, "sign-in.html"));
});

app.get("/create-account", (req, res) => {
  res.sendFile(path.join(publicDir, "create-account.html"));
});

app.use(express.static(publicDir, { index: false }));
app.use(express.json({ limit: "256kb" }));

app.get("/meeting", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

function defaultIceServers() {
  return [
    { urls: ["stun:stun.cloudflare.com:3478"] },
    { urls: ["stun:stun.l.google.com:19302"] }
  ];
}

function normalizeIceUrls(urls) {
  const list = Array.isArray(urls)
    ? urls
    : String(urls || "")
        .split(/[\s,]+/)
        .map((value) => value.trim())
        .filter(Boolean);

  // Cloudflare notes that port 53 often times out in browsers, so filter it out.
  return list.filter((value) => !/:53(?:\?|$)/.test(String(value)));
}

async function getCloudflareIceServers() {
  const apiToken = process.env.CLOUDFLARE_TURN_API_TOKEN;
  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID;
  const ttl = Number(process.env.CLOUDFLARE_TURN_TTL || 86400);

  if (!apiToken || !keyId) return null;

  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ ttl: Number.isFinite(ttl) && ttl > 0 ? ttl : 86400 })
    }
  );

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`Cloudflare TURN request failed (${response.status}): ${details}`);
  }

  const payload = await response.json();
  const servers = Array.isArray(payload?.iceServers) ? payload.iceServers : [];

  return servers
    .map((server) => {
      const normalizedUrls = normalizeIceUrls(server?.urls);
      if (!normalizedUrls.length) return null;
      return {
        ...server,
        urls: normalizedUrls
      };
    })
    .filter(Boolean);
}

app.get("/ice", async (req, res) => {
  const iceServers = defaultIceServers();

  try {
    const cloudflareIceServers = await getCloudflareIceServers();
    if (cloudflareIceServers?.length) {
      return res.json({
        provider: "cloudflare",
        iceServers: [...iceServers, ...cloudflareIceServers]
      });
    }
  } catch (err) {
    console.error("Failed to generate Cloudflare TURN credentials:", err);
  }

  const { TURN_URL, TURN_USERNAME, TURN_CREDENTIAL } = process.env;
  if (TURN_URL && TURN_USERNAME && TURN_CREDENTIAL) {
    iceServers.push({
      urls: normalizeIceUrls(TURN_URL),
      username: TURN_USERNAME,
      credential: TURN_CREDENTIAL
    });

    return res.json({ provider: "static-turn", iceServers });
  }

  return res.json({ provider: "stun-only", iceServers });
});

function requireEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

let mongoClient;
let MONGODB_DB;

let surveysCollection;
let meetingsCollection;
let analysesCollection;
let usersCollection;

async function connectMongo() {
  const MONGODB_URI = requireEnv("MONGODB_URI");
  MONGODB_DB = process.env.MONGODB_DB || "meeting_analyzer";

  mongoClient = new MongoClient(MONGODB_URI);
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

function normalizeUsername(username) {
  return String(username || "").trim();
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
  return `scrypt:${salt}:${Buffer.from(derived).toString("hex")}`;
}

async function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== "string") return false;

  const [scheme, salt, originalHex] = storedHash.split(":");
  if (scheme !== "scrypt" || !salt || !originalHex) return false;

  const derived = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });

  const actual = Buffer.from(derived).toString("hex");
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(originalHex, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

app.post("/api/auth/register", async (req, res) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const password = String(req.body?.password || "");

    if (!username) return res.status(400).json({ error: "Missing username" });
    if (!password) return res.status(400).json({ error: "Missing password" });
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

    const existing = await usersCollection.findOne({ username });
    if (existing) {
      return res.status(409).json({ error: "That username is already in use" });
    }

    const passwordHash = await hashPassword(password);
    const insertResult = await usersCollection.insertOne({
      username,
      passwordHash,
      createdAt: now(),
      updatedAt: now()
    });

    const userId = String(insertResult.insertedId);
    const token = signToken({ uid: userId, uname: username, iat: Date.now() });
    return res.status(201).json({ token, user: { id: userId, username }, created: true });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "Failed to create account" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const password = String(req.body?.password || "");

    if (!username) return res.status(400).json({ error: "Missing username" });
    if (!password) return res.status(400).json({ error: "Missing password" });

    const existing = await usersCollection.findOne({ username });

    if (!existing) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    if (!existing.passwordHash) {
      return res.status(409).json({ error: "This account exists without a password. Delete the user record or add a password hash before signing in." });
    }

    const ok = await verifyPassword(password, existing.passwordHash);
    if (!ok) return res.status(401).json({ error: "Invalid username or password" });

    await usersCollection.updateOne({ _id: existing._id }, { $set: { updatedAt: now() } });

    const userId = String(existing._id);
    const token = signToken({ uid: userId, uname: username, iat: Date.now() });
    res.json({ token, user: { id: userId, username }, created: false });
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

    const result = await aiAnalyzeTranscript(transcript);

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

function getClientDisplayName(ws) {
  const fallback = ws.role === "host" ? "Host" : `Peer ${ws.clientId}`;
  return String(ws.displayName || fallback).trim() || fallback;
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
      const displayName = String(msg.displayName || "").trim();
      if (!code) return;

      ws.roomCode = code;
      ws.role = role;
      ws.displayName = displayName || (role === "host" ? "Host" : `Peer ${ws.clientId}`);
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

      const members = Array.from(room.clients.entries())
        .filter(([id]) => id !== ws.clientId)
        .map(([id, peer]) => ({ id, name: getClientDisplayName(peer) }));

      send(ws, { type: "room-joined", room: code, members, hostId: room.hostId, displayName: getClientDisplayName(ws) });

      for (const [id, peer] of room.clients) {
        if (id !== ws.clientId) {
          send(peer, { type: "peer-joined", peerId: ws.clientId, name: getClientDisplayName(ws) });
        }
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
