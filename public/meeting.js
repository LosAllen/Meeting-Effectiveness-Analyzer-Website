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

let micMuted = false;
let videoOff = false;

const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

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

  // Mute badge overlay (works for any tile)
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

  const tile = remoteTiles.get(peerId);
  if (tile) {
    tile.tileEl.remove();
    remoteTiles.delete(peerId);
  }

  peers.delete(peerId);
  updateStatus();
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

    // Try autoplay
    const ok = await safePlay(tile.videoEl);

    // If autoplay fails, show button. If autoplay works but audio is blocked,
    // the button still helps.
    if (!ok) {
      // muted autoplay often works even when audio autoplay is blocked
      tile.videoEl.muted = true;
      await safePlay(tile.videoEl);
      showEnableAudio(true);
    } else {
      // If we haven't unlocked audio yet, keep remote muted to avoid errors.
      if (!audioUnlocked) {
        tile.videoEl.muted = true;
        showEnableAudio(true);
      } else {
        tile.videoEl.muted = false;
      }
    }

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      const tile = ensureRemoteTile(peerId);
      tile.labelEl.textContent = `Peer ${peerId} (${state})`;
    };

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

  peerConnections.set(peerId, pc);
  return pc;
}

async function sendOffer(peerId) {
  const pc = createPeerConnection(peerId);

  // IMPORTANT: only offer if we're stable (avoids weird state edges)
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

  // If we somehow already have a local offer, ignore/rollback strategy could be added.
  // For now we assume glare is prevented by our offer rules.
  await pc.setRemoteDescription(offer);

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

  // Only set remote answer if we are in the correct state
  if (pc.signalingState !== "have-local-offer") {
    // This prevents: "Called in wrong state: stable"
    return;
  }
  await pc.setRemoteDescription(answer);
}

async function handleIce(from, candidate) {
  const pc = createPeerConnection(from);
  try { await pc.addIceCandidate(candidate); } catch {}
}

function broadcastMediaState() {
  // Send mute/video state to every peer via the signaling relay
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

    // local badge + broadcast
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

  // local tile appears immediately
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

      // roster = peers already in room
      peers.clear();
      members.forEach(id => peers.add(String(id)));
      updateStatus();

      // NEW JOINER sends offers to existing members (ONLY THIS PATH sends offers)
      for (const peerId of members) {
        ensureRemoteTile(peerId);
        createPeerConnection(peerId);
        await sendOffer(peerId);
      }

      // Share our current media state to everyone we know now
      broadcastMediaState();
      return;
    }

    if (msg.type === "peer-joined") {
      const peerId = String(msg.peerId);

      peers.add(peerId);
      updateStatus();

      ensureRemoteTile(peerId);
      createPeerConnection(peerId);

      // Do NOT sendOffer here.
      // Existing peers wait; the new peer (room-joined) will offer to us.
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
