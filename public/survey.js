const params = new URLSearchParams(location.search);
const code = (params.get("code") || "").trim().toUpperCase();
const clientId = (params.get("clientId") || "").trim();
const role = (params.get("role") || "").trim();

document.getElementById("codeLabel").textContent = code || "(missing)";

const form = document.getElementById("surveyForm");
const statusEl = document.getElementById("status");
const submitBtn = document.getElementById("submitBtn");
const skipBtn = document.getElementById("skipBtn");

function setStatus(msg) {
  statusEl.textContent = msg;
}

skipBtn.addEventListener("click", () => {
  // Go back home (or close if popup)
  window.close();
  setTimeout(() => (location.href = "/"), 150);
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  if (!code) {
    setStatus("Missing meeting code.");
    return;
  }

  const fd = new FormData(form);
  const payload = {
    meetingCode: code,
    respondentId: clientId || null,
    role: role || "join",
    answers: {
      overall: Number(fd.get("overall")),
      clarity: Number(fd.get("clarity")),
      participation: Number(fd.get("participation")),
      improve: (fd.get("improve") || "").toString().trim(),
      worked: (fd.get("worked") || "").toString().trim()
    }
  };

  submitBtn.disabled = true;
  setStatus("Submitting…");

  try {
    const res = await fetch("/api/surveys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || "Request failed");
    }

    setStatus("Thanks! Your response was saved.");
    setTimeout(() => {
      window.close();
      setTimeout(() => (location.href = "/"), 150);
    }, 800);
  } catch (err) {
    console.error(err);
    setStatus("Could not save survey. " + (err?.message || ""));
  } finally {
    submitBtn.disabled = false;
  }
});
