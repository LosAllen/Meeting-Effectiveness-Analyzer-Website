const params = new URLSearchParams(location.search);
const focusCode = (params.get("code") || "").trim().toUpperCase();

const meetingsList = document.getElementById("meetingsList");
const detail = document.getElementById("detail");
const transcriptEl = document.getElementById("transcript");
const analyzeBtn = document.getElementById("analyzeBtn");
const analyzeStatus = document.getElementById("analyzeStatus");
const analysisBox = document.getElementById("analysis");

let selectedCode = focusCode || null;

function fmtDate(d) {
  if (!d) return "—";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "—";
  return dt.toLocaleString();
}

function fmtDuration(seconds) {
  if (seconds == null) return "—";
  const s = Number(seconds);
  if (!Number.isFinite(s)) return "—";
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r}s`;
}

function setDetailLoading() {
  detail.innerHTML = `<p class="muted">Loading…</p>`;
  analysisBox.innerHTML = "";
  analyzeStatus.textContent = "";
}

function renderMeetings(items) {
  if (!items.length) {
    meetingsList.innerHTML = `<p class="muted">No meetings yet. Host and end a meeting to generate results.</p>`;
    return;
  }

  meetingsList.innerHTML = "";
  for (const m of items) {
    const code = String(m.code || "").toUpperCase();
    const row = document.createElement("button");
    row.type = "button";
    row.className = `listRow ${selectedCode === code ? "active" : ""}`;
    row.innerHTML = `
      <div>
        <div class="rowTitle">${code}</div>
        <div class="muted small">Started: ${fmtDate(m.startedAt)}</div>
      </div>
      <div class="muted small" style="text-align:right">
        <div>Max: ${m.maxParticipants ?? "—"}</div>
        <div>Dur: ${fmtDuration(m.durationSeconds)}</div>
      </div>
    `;
    row.addEventListener("click", () => {
      selectedCode = code;
      history.replaceState(null, "", `/dashboard.html?code=${encodeURIComponent(code)}`);
      loadMeeting(code);
      // refresh highlight
      document.querySelectorAll(".listRow").forEach((el) => el.classList.remove("active"));
      row.classList.add("active");
    });
    meetingsList.appendChild(row);
  }
}

function renderMeetingDetail(data) {
  const m = data.meeting || {};
  const score = data.score;
  const agg = data.aggregates || {};

  detail.innerHTML = `
    <div class="kv">
      <div><span class="k">Code</span><span class="v">${(m.code || selectedCode || "").toUpperCase()}</span></div>
      <div><span class="k">Started</span><span class="v">${fmtDate(m.startedAt)}</span></div>
      <div><span class="k">Ended</span><span class="v">${fmtDate(m.endedAt)}</span></div>
      <div><span class="k">Duration</span><span class="v">${fmtDuration(m.durationSeconds)}</span></div>
      <div><span class="k">Max participants</span><span class="v">${m.maxParticipants ?? "—"}</span></div>
    </div>

    <div class="score">
      <div class="scoreNum">${score == null ? "—" : score}</div>
      <div class="muted">Effectiveness score (0–100)</div>
    </div>

    <div class="kv" style="margin-top:12px">
      <div><span class="k">Survey responses</span><span class="v">${agg.count ?? 0}</span></div>
      <div><span class="k">Avg overall</span><span class="v">${agg.avgOverall ?? "—"}</span></div>
      <div><span class="k">Avg clarity</span><span class="v">${agg.avgClarity ?? "—"}</span></div>
      <div><span class="k">Avg participation</span><span class="v">${agg.avgParticipation ?? "—"}</span></div>
    </div>

    <div class="twoCol">
      <div>
        <strong>What worked</strong>
        ${agg.worked?.length ? `<ul>${agg.worked.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>` : `<p class="muted">No comments yet.</p>`}
      </div>
      <div>
        <strong>What to improve</strong>
        ${agg.improve?.length ? `<ul>${agg.improve.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>` : `<p class="muted">No comments yet.</p>`}
      </div>
    </div>
  `;

  // Render stored analysis if present
  if (data.analysis) {
    renderAnalysis(data.analysis);
  } else {
    analysisBox.innerHTML = `<p class="muted">No transcript analysis yet.</p>`;
  }
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderAnalysis(a) {
  const summary = escapeHtml(a.summary || "");
  const suggestions = Array.isArray(a.suggestions) ? a.suggestions : [];
  analysisBox.innerHTML = `
    <div class="analysisCard">
      <div class="muted small">Model: ${escapeHtml(a.model || "")}</div>
      <p><strong>Summary</strong></p>
      <p>${summary || "—"}</p>
      <p><strong>Suggestions</strong></p>
      ${suggestions.length ? `<ul>${suggestions.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>` : `<p class="muted">—</p>`}
    </div>
  `;
}

async function loadMeetings() {
  const res = await fetch("/api/meetings", { cache: "no-store" });
  const data = await res.json();
  const items = data.meetings || [];
  renderMeetings(items);

  if (!selectedCode && items.length) {
    selectedCode = String(items[0].code || "").toUpperCase();
  }
  if (selectedCode) await loadMeeting(selectedCode);
}

async function loadMeeting(code) {
  setDetailLoading();
  const res = await fetch(`/api/meetings/${encodeURIComponent(code)}`, { cache: "no-store" });
  if (!res.ok) {
    detail.innerHTML = `<p class="muted">Could not load meeting.</p>`;
    return;
  }
  const data = await res.json();
  renderMeetingDetail(data);
}

analyzeBtn.addEventListener("click", async () => {
  if (!selectedCode) return;
  const transcript = transcriptEl.value || "";
  if (!transcript.trim()) {
    analyzeStatus.textContent = "Paste a transcript first.";
    return;
  }

  analyzeBtn.disabled = true;
  analyzeStatus.textContent = "Analyzing…";
  try {
    const res = await fetch(`/api/meetings/${encodeURIComponent(selectedCode)}/transcript`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript })
    });

    if (!res.ok) {
      const t = await res.text();
      throw new Error(t || "Request failed");
    }

    analyzeStatus.textContent = "Saved.";
    // reload meeting to show stored analysis
    await loadMeeting(selectedCode);
  } catch (err) {
    console.error(err);
    analyzeStatus.textContent = "Failed to analyze.";
  } finally {
    analyzeBtn.disabled = false;
  }
});

document.getElementById("refreshBtn").addEventListener("click", loadMeetings);

loadMeetings().catch((err) => {
  console.error(err);
  meetingsList.innerHTML = `<p class="muted">Failed to load meetings.</p>`;
});
