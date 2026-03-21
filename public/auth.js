const TOKEN_KEY = "mea_token";
const USER_KEY = "mea_user";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

export function getUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setSession(token, user) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

async function readErrorMessage(res, fallback) {
  try {
    const data = await res.json();
    return data?.error || fallback;
  } catch {
    const msg = await res.text();
    return msg || fallback;
  }
}

async function submitAuth(url, username, password, fallback) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });

  if (!res.ok) {
    throw new Error(await readErrorMessage(res, fallback));
  }

  const data = await res.json();
  setSession(data.token, data.user);
  return data.user;
}

export async function login(username, password) {
  return submitAuth("/api/auth/login", username, password, "Login failed");
}

export async function register(username, password) {
  return submitAuth("/api/auth/register", username, password, "Account creation failed");
}

export async function fetchMe() {
  const token = getToken();
  if (!token) return null;

  const res = await fetch("/api/auth/me", {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store"
  });

  if (!res.ok) return null;
  const data = await res.json();
  if (data?.user) setSession(token, data.user);
  return data.user || null;
}

export async function apiFetch(url, opts = {}) {
  const token = getToken();
  const headers = new Headers(opts.headers || {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(url, { ...opts, headers });
}
