import { fetchMe, login } from "./auth.js";

const usernameInput = document.getElementById("usernameInput");
const passwordInput = document.getElementById("passwordInput");
const loginBtn = document.getElementById("loginBtn");
const loginStatus = document.getElementById("loginStatus");

function showError(message) {
  loginStatus.textContent = message;
  loginStatus.style.color = "#ff9c9c";
}

function showMuted(message) {
  loginStatus.textContent = message;
  loginStatus.style.color = "";
}

async function submit() {
  const username = (usernameInput.value || "").trim();
  const password = passwordInput.value || "";

  if (!username) return showError("Enter your username.");
  if (!password) return showError("Enter your password.");

  loginBtn.disabled = true;
  showMuted("Signing in…");

  try {
    await login(username, password);
    location.href = "/";
  } catch (err) {
    console.error(err);
    showError(err.message || "Invalid username or password.");
  } finally {
    loginBtn.disabled = false;
  }
}

loginBtn.addEventListener("click", submit);
[usernameInput, passwordInput].forEach((input) => {
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
});

fetchMe().then((user) => {
  if (user) location.href = "/";
}).catch(() => {});
