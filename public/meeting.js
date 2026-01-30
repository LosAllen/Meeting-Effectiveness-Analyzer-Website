const params = new URLSearchParams(location.search);
const code = (params.get("code") || "").trim().toUpperCase();
const role = (params.get("role") || "").trim();

const codeLabel = document.getElementById("codeLabel");
const roleLabel = document.getElementById("roleLabel");
if (codeLabel) codeLabel.textContent = code || "(missing)";
if (roleLabel) roleLabel.textContent = role || "(unknown)";

const statusEl = document.getElementById("status");
function setStatus(t) { statusEl.textContent = t; }

const grid = document.getElementById("grid");

let ws;
let clientId = null;
let localStream = null;

const peerConnections = new Map(); // peerId -> RTCPeerConnection
const remoteTiles = new Map();     // peerId -> tile object
const peers = new Set();           // peerIds currently known (for counts)

const pendingIce = new Map();      

let micMuted = false;
let videoOff = false;

const enableAudioBtn = document.getElementById("enableAudioBtn");
let audioUnlocked = false;

function showEnableAudio(show) {
  if (!enableAudioBtn) return;
  enableAudioBtn.style.display = show ? "block" : "none";
}

async function safePlay(videoEl) {
  try {
    await videoEl.play();
    return true;
  } catch {
    return false;
  }
}

// One click unlocks audio playback for the whole window
enableAudioBtn?.addEventListener("click", async () => {
  audioUnlocked = true;
  showEnableAudio(false);

  // Try to play all remote videos unmuted now that we have a user gesture
  for (const [, t] of remoteTiles) {
    t.videoEl.muted = false;
    await safePlay(t.videoEl);
  }
});

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}`;
}

async function startLocalMedia() {
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
}

function updateStatus() {
  setStatus(`In meeting ${code}. Peers: ${peers.size}`);
}

function makeTile(label, muted = false) {
  const tile = document.createElement("div");
  tile.className = "tile";

  const tileLabel = document.createElement("div");
  tileLabel.className = "tileLabel";
  tileLabel.textContent = label;

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = muted;

  // Mute badge overlay
  const badge = document.createElement("div");
  badge.className = "badge";
  badge.title = "Muted";
  badge.textContent = "🔇";
  badge.style.display = "none";

  tile.appendChild(tileLabel);
  tile.appendChild(badge);
  tile.appendChild(video);
  grid.appendChild(tile);

  return {
    tileEl: tile,
    videoEl: video,
    labelEl: tileLabel,
    badgeEl: badge,
    setMuted(isMuted) {
      badge.style.display = isMuted ? "flex" : "none";
    }
  };
}

function ensureRemoteTile(peerId) {
  if (remoteTiles.has(peerId)) return remoteTiles.get(peerId);
  const t = makeTile(`Peer ${peerId}`, false);
  remoteTiles.set(peerId, t);
  return t;
}

function removeRemote(peerId) {
  const pc = peerConnections.get(peerId);
  if (pc) {
    try { pc.close(); } catch {}
    peerConnections.delete(peerId);
  }

  pendingIce.delete(peerId);

  const tile = remoteTiles.get(peerId);
  if (tile) {
    tile.tileEl.remove();
    remoteTiles.delete(peerId);
  }

  peers.delete(peerId);
  updateStatus();
}

async function getRtcConfig() {
  // Server can optionally provide TURN creds. If none, it returns STUN-only.
  try {
    const res = await fetch("/ice", { cache: "no-store" });
    if (!res.ok) throw new Error("ice config not available");
    const data = await res.json();
    if (data?.iceServers?.length) return { iceServers: data.iceServers };
  } catch {
    // fall through
  }

  // Safe default. Works on some networks, not all.
  return {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:global.stun.twilio.com:3478" }
    ]
  };
}

let rtcConfig = null;

function flushPendingIce(peerId) {
  const pc = peerConnections.get(peerId);
  if (!pc || !pc.remoteDescription) return;

  const list = pendingIce.get(peerId);
  if (!list || list.length === 0) return;

  pendingIce.set(peerId, []);
  for (const cand of list) {
    pc.addIceCandidate(cand).catch(() => {});
  }
}

function createPeerConnection(peerId) {
  if (peerConnections.has(peerId)) return peerConnections.get(peerId);

  const pc = new RTCPeerConnection(rtcConfig);

  // add local tracks
  for (const track of localStream.getTracks()) {
    pc.addTrack(track, localStream);
  }

  pc.ontrack = async (ev) => {
    const tile = ensureRemoteTile(peerId);
    tile.videoEl.srcObject = ev.streams[0];

    const ok = await safePlay(tile.videoEl);
    if (!ok) {
      tile.videoEl.muted = true;
      await safePlay(tile.videoEl);
      showEnableAudio(true);
    } else {
      if (!audioUnlocked) {
        tile.videoEl.muted = true;
        showEnableAudio(true);
      } else {
        tile.videoEl.muted = false;
      }
    }
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      ws.send(JSON.stringify({
        type: "signal",
        to: peerId,
        data: { kind: "ice", candidate: ev.candidate }
      }));
    }
  };

  pc.oniceconnectionstatechange = () => {
    const state = pc.iceConnectionState;
    const tile = ensureRemoteTile(peerId);
    tile.labelEl.textContent = `Peer ${peerId} (${state})`;
  };

  pc.onconnectionstatechange = () => {
    // For debugging why it fails on Render / real networks
    // states: new -> connecting -> connected, or failed/disconnected
    // console.log("pc connectionState", peerId, pc.connectionState);
  };

  peerConnections.set(peerId, pc);
  return pc;
}

async function sendOffer(peerId) {
  const pc = createPeerConnection(peerId);

  if (pc.signalingState !== "stable") return;

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  ws.send(JSON.stringify({
    type: "signal",
    to: peerId,
    data: { kind: "offer", sdp: offer }
  }));
}

async function handleOffer(from, offer) {
  const pc = createPeerConnection(from);

  await pc.setRemoteDescription(offer);
  flushPendingIce(from);

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  ws.send(JSON.stringify({
    type: "signal",
    to: from,
    data: { kind: "answer", sdp: answer }
  }));
}

async function handleAnswer(from, answer) {
  const pc = createPeerConnection(from);

  if (pc.signalingState !== "have-local-offer") return;

  await pc.setRemoteDescription(answer);
  flushPendingIce(from);
}

async function handleIce(from, candidate) {
  const pc = createPeerConnection(from);

  // Buffer early candidates until we have a remoteDescription
  if (!pc.remoteDescription) {
    const arr = pendingIce.get(from) || [];
    arr.push(candidate);
    pendingIce.set(from, arr);
    return;
  }

  try { await pc.addIceCandidate(candidate); } catch {}
}

function broadcastMediaState() {
  for (const peerId of peers) {
    ws.send(JSON.stringify({
      type: "signal",
      to: peerId,
      data: { kind: "media-state", micMuted, videoOff }
    }));
  }
}

function hookControls(localTile) {
  const muteBtn = document.getElementById("muteBtn");
  const videoBtn = document.getElementById("videoBtn");
  const leaveBtn = document.getElementById("leaveBtn");

  muteBtn.addEventListener("click", () => {
    micMuted = !micMuted;
    localStream.getAudioTracks().forEach(t => (t.enabled = !micMuted));
    muteBtn.textContent = micMuted ? "Unmute mic" : "Mute mic";
    localTile.setMuted(micMuted);
    broadcastMediaState();
  });

  videoBtn.addEventListener("click", () => {
    videoOff = !videoOff;
    localStream.getVideoTracks().forEach(t => (t.enabled = !videoOff));
    videoBtn.textContent = videoOff ? "Enable video" : "Disable video";
    broadcastMediaState();
  });

  leaveBtn.addEventListener("click", () => cleanupAndClose());
  window.addEventListener("beforeunload", cleanup);
}

function cleanup() {
  try { ws?.close(); } catch {}

  for (const [, pc] of peerConnections) {
    try { pc.close(); } catch {}
  }
  peerConnections.clear();
  pendingIce.clear();

  for (const [, t] of remoteTiles) {
    try { t.tileEl.remove(); } catch {}
  }
  remoteTiles.clear();

  peers.clear();

  if (localStream) localStream.getTracks().forEach(t => t.stop());
}

function cleanupAndClose() {
  cleanup();
  window.close();
  setTimeout(() => (location.href = "/"), 200);
}

async function main() {
  if (!code) {
    setStatus("Missing meeting code.");
    return;
  }

  setStatus("Requesting camera/mic…");
  await startLocalMedia();

  // Fetch ICE config
  rtcConfig = await getRtcConfig();

  const localTile = makeTile("You", true);
  localTile.videoEl.srcObject = localStream;
  localTile.setMuted(false);

  hookControls(localTile);

  setStatus("Connecting…");
  ws = new WebSocket(wsUrl());

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "join-room", code }));
    setStatus("Joined room. Syncing peers…");
  });

  ws.addEventListener("message", async (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.type === "hello") {
      clientId = msg.clientId;
      return;
    }

    if (msg.type === "room-full") {
      setStatus(`Room is full (max ${msg.max}).`);
      return;
    }

    if (msg.type === "room-joined") {
      const members = msg.members || [];

      peers.clear();
      members.forEach(id => peers.add(String(id)));
      updateStatus();

      // New joiner sends offers to existing members
      for (const peerId of members) {
        ensureRemoteTile(peerId);
        createPeerConnection(peerId);
        await sendOffer(peerId);
      }

      broadcastMediaState();
      return;
    }

    if (msg.type === "peer-joined") {
      const peerId = String(msg.peerId);
      peers.add(peerId);
      updateStatus();

      ensureRemoteTile(peerId);
      createPeerConnection(peerId);

      // Existing peers wait: the new peer will offer
      return;
    }

    if (msg.type === "peer-left") {
      removeRemote(String(msg.peerId));
      return;
    }

    if (msg.type === "signal") {
      const from = String(msg.from);
      const data = msg.data;

      if (data.kind === "offer") {
        await handleOffer(from, data.sdp);
      } else if (data.kind === "answer") {
        await handleAnswer(from, data.sdp);
      } else if (data.kind === "ice") {
        await handleIce(from, data.candidate);
      } else if (data.kind === "media-state") {
        const tile = ensureRemoteTile(from);
        tile.setMuted(!!data.micMuted);
      }
      return;
    }
  });

  ws.addEventListener("close", () => setStatus("Signaling disconnected."));
  ws.addEventListener("error", () => setStatus("Signaling error."));
}

main().catch((err) => {
  console.error(err);
  setStatus("Error: " + err.message);
});
