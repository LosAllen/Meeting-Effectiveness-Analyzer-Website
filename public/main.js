import { getUser } from "./auth.js";

function randomCode(len = 6) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function openMeetingPopup(code, role, displayName) {
  const url = `/meeting.html?code=${encodeURIComponent(code)}&role=${encodeURIComponent(role)}&displayName=${encodeURIComponent(displayName || "")}`;

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
  const token = localStorage.getItem("mea_token") || "";
  if (!token) {
    alert("Please sign in on the dashboard before hosting so meetings are saved under your account.");
    location.href = "/";
    return;
  }

  const user = getUser();
  const hostDisplayName = (user?.username || "Host").trim();
  const code = randomCode(6);
  openMeetingPopup(code, "host", hostDisplayName);
});

document.getElementById("joinBtn").addEventListener("click", () => {
  const code = document.getElementById("codeInput").value.trim().toUpperCase();
  if (!code) {
    alert("Enter a meeting code first.");
    return;
  }

  const enteredName = window.prompt("Enter your display name:", "") || "";
  const displayName = enteredName.trim();
  if (!displayName) {
    alert("Please enter a display name before joining.");
    return;
  }

  openMeetingPopup(code, "join", displayName);
});
