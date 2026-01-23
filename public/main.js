function randomCode(len = 6) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function openMeetingPopup(code, role) {
  // role: "host" or "join"
  const url = `/meeting.html?code=${encodeURIComponent(code)}&role=${encodeURIComponent(role)}`;

  // Pop-out window
  const w = 980, h = 680;
  const left = Math.max(0, (screen.width - w) / 2);
  const top = Math.max(0, (screen.height - h) / 2);
  const features = `popup=yes,width=${w},height=${h},left=${left},top=${top}`;

  const win = window.open(url, "meetingWindow", features);

  if (!win) {
    alert("Popup blocked. Please allow popups for this site.");
    return;
  }
  win.focus();
}

document.getElementById("hostBtn").addEventListener("click", () => {
  const code = randomCode(6);
  openMeetingPopup(code, "host");
});

document.getElementById("joinBtn").addEventListener("click", () => {
  const code = document.getElementById("codeInput").value.trim().toUpperCase();
  if (!code) {
    alert("Enter a meeting code first.");
    return;
  }
  openMeetingPopup(code, "join");
});
