import { fetchMe, register } from "./auth.js";

const usernameInput = document.getElementById("usernameInput");
const passwordInput = document.getElementById("passwordInput");
const confirmPasswordInput = document.getElementById("confirmPasswordInput");
const registerBtn = document.getElementById("registerBtn");
const registerStatus = document.getElementById("registerStatus");

function showError(message) {
  registerStatus.textContent = message;
  registerStatus.style.color = "#ff9c9c";
}

function showMuted(message) {
  registerStatus.textContent = message;
  registerStatus.style.color = "";
}

async function submit() {
  const username = (usernameInput.value || "").trim();
  const password = passwordInput.value || "";
  const confirmPassword = confirmPasswordInput.value || "";

  if (!username) return showError("Enter a username.");
  if (!password) return showError("Enter a password.");
  if (password.length < 6) return showError("Password must be at least 6 characters.");
  if (password !== confirmPassword) return showError("Passwords do not match.");

  registerBtn.disabled = true;
  showMuted("Creating account…");

  try {
    await register(username, password);
    location.href = "/";
  } catch (err) {
    console.error(err);
    showError(err.message || "Could not create account.");
  } finally {
    registerBtn.disabled = false;
  }
}

registerBtn.addEventListener("click", submit);
[usernameInput, passwordInput, confirmPasswordInput].forEach((input) => {
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
});

fetchMe().then((user) => {
  if (user) location.href = "/";
}).catch(() => {});
