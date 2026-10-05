// ─── Time blocks on Google Calendar ──────────────────────────────────
//
// calendar. (calhub) blocks out time for a task with an ordinary event on
// the main calendar that carries the task's ID in its private properties
// (calhubTask / calhubSpace / calhubDone). This reads those blocks to show a
// task's time, and makes new ones in exactly the same shape, so a block made
// here is a block there too.
//
// Sign-in is calendar.'s: the same Google client, the same token kept under
// "calendar.google". Both apps are on the same site, so in a browser one
// sign-in serves both. A home-screen app on iPhone has storage of its own,
// so this can also sign in by itself, with the same full-page redirect
// calendar. uses (popups are unreliable there). The token lasts an hour;
// after that a quiet trip through Google with prompt=none brings a new one.

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const API = "https://www.googleapis.com/calendar/v3";
const SCOPE = "https://www.googleapis.com/auth/calendar";
const KEY = "calendar.google";
const STATE_KEY = "tasks.oauthState";
const SILENT_KEY = "tasks.silentTried";
const PENDING_KEY = "tasks.pendingBlocks";
// The lifeOS picker reads this prefix to hand Google's reply to this frame.
const STATE_PREFIX = "tasks:";
export const DEFAULT_MINUTES = 60;

const read = (k, fallback) => { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

const auth = () => read(KEY, {});
export const isConnected = () => { const a = auth(); return Boolean(a.token && a.expires > Date.now()); };
export const wasConnected = () => Boolean(auth().email);
export const email = () => auth().email || "";
export const silentTried = () => { try { return sessionStorage.getItem(SILENT_KEY) === "1"; } catch { return true; } };

// calendar.'s client ID, unless one has been set here.
export const calendarClientId = () => read("calendar.settings", {}).clientId || "";

// Google won't show sign-in inside a frame, so inside the lifeOS picker the
// whole page goes, and the picker hands the reply back to this frame.
function sameSiteTop() {
  try {
    return window.top !== window && window.top.location.origin === location.origin ? window.top : null;
  } catch { return null; }
}

export function connect(clientId, { silent = false } = {}) {
  const state = STATE_PREFIX + crypto.randomUUID();
  try {
    sessionStorage.setItem(STATE_KEY, state);
    if (silent) sessionStorage.setItem(SILENT_KEY, "1");
  } catch { /* private mode: the state check will fail safe */ }
  const page = sameSiteTop() || window;
  const params = new URLSearchParams({
    client_id: clientId.trim(),
    redirect_uri: page.location.origin + page.location.pathname,
    response_type: "token",
    scope: SCOPE,
    include_granted_scopes: "true",
    state,
  });
  if (silent) params.set("prompt", "none");
  if (email()) params.set("login_hint", email());
  page.location.assign(`${AUTH}?${params}`);
}

// Called once on load. null when the page wasn't opened by Google, else
// { ok } or { error }.
export function takeRedirect() {
  if (!/(?:^#|&)(?:access_token|error)=/.test(location.hash)) return null;
  const h = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, "", location.pathname + location.search);
  let expected = null;
  try { expected = sessionStorage.getItem(STATE_KEY); sessionStorage.removeItem(STATE_KEY); } catch { /* none */ }
  if (!expected || h.get("state") !== expected) return { error: "state" };
  if (h.get("error")) return { error: h.get("error") };
  const seconds = Number(h.get("expires_in")) || 3600;
  write(KEY, { ...auth(), token: h.get("access_token"), expires: Date.now() + (seconds - 60) * 1000 });
  try { sessionStorage.removeItem(SILENT_KEY); } catch { /* none */ }
  return { ok: true };
}

export function disconnect() {
  try { localStorage.removeItem(KEY); } catch { /* none */ }
}

async function api(path, { method = "GET", body, query } = {}) {
  const { token, expires } = auth();
  if (!token || expires <= Date.now()) {
    const err = new Error("Google sign-in has expired");
    err.status = 401;
    throw err;
  }
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const resp = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (resp.status === 401) write(KEY, { ...auth(), token: null, expires: 0 });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    let detail = text;
    try { detail = JSON.parse(text).error.message; } catch { /* not JSON */ }
    const err = new Error(`${resp.status}${detail ? ` — ${String(detail).slice(0, 160)}` : ""}`);
    err.status = resp.status;
    throw err;
  }
  return resp.status === 204 ? null : resp.json();
}

// The primary calendar's ID is the account's email, kept as the hint for
// signing in quietly next time, as calendar. does.
async function rememberEmail() {
  if (email()) return;
  const cal = await api("/calendars/primary", { query: { fields: "id" } }).catch(() => null);
  if (cal?.id) write(KEY, { ...auth(), email: cal.id });
}

const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const pad = (n) => String(n).padStart(2, "0");
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const at = (date, time) => { const [y, m, d] = date.split("-").map(Number); const [h, min] = time.split(":").map(Number); return new Date(y, m - 1, d, h, min); };

function toBlock(e) {
  const p = e.extendedProperties?.private || {};
  const start = new Date(e.start.dateTime);
  const end = new Date(e.end?.dateTime || e.start.dateTime);
  return { id: e.id, taskId: p.calhubTask, done: p.calhubDone === "1", start, end, day: isoDay(start) };
}

// Every block that isn't done, by task ID: the latest one for each task, as
// calendar. picks it. A month back covers overdue tasks.
export async function loadBlocks() {
  await rememberEmail();
  const from = new Date(); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - 31);
  const to = new Date(from); to.setDate(to.getDate() + 31 + 365);
  const items = [];
  let pageToken;
  do {
    const page = await api("/calendars/primary/events", {
      query: {
        timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", maxResults: 2500,
        fields: "nextPageToken,items(id,status,start,end,extendedProperties)",
        ...(pageToken ? { pageToken } : {}),
      },
    });
    items.push(...(page.items || []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  const blocks = new Map();
  for (const e of items) {
    if (e.status === "cancelled" || !e.start?.dateTime || !e.extendedProperties?.private?.calhubTask) continue;
    const b = toBlock(e);
    if (b.done) continue;
    const had = blocks.get(b.taskId);
    if (!had || b.start > had.start) blocks.set(b.taskId, b);
  }
  return blocks;
}

// { id, text, spaceId } + "YYYY-MM-DD" + "HH:MM" → a block on the main calendar.
export async function createBlock(task, date, time, minutes = DEFAULT_MINUTES) {
  const start = at(date, time);
  const end = new Date(start.getTime() + minutes * 60000);
  const e = await api("/calendars/primary/events", {
    method: "POST",
    body: {
      summary: task.text,
      start: { dateTime: start.toISOString(), timeZone: zone() },
      end: { dateTime: end.toISOString(), timeZone: zone() },
      extendedProperties: { private: { calhubTask: String(task.id), calhubSpace: task.spaceId } },
    },
  });
  return toBlock(e);
}

// A task moved to another day takes its block along, at the same time.
export async function moveBlock(block, date) {
  const start = at(date, hhmm(block.start));
  const end = new Date(start.getTime() + (block.end - block.start));
  const e = await api(`/calendars/primary/events/${encodeURIComponent(block.id)}`, {
    method: "PATCH",
    body: { start: { dateTime: start.toISOString(), timeZone: zone() }, end: { dateTime: end.toISOString(), timeZone: zone() } },
  });
  return toBlock(e);
}

// Blocks waiting for a sign-in: the task is already added, so only the
// block is owed. Kept on the device until Google is reachable again.
export const pending = () => read(PENDING_KEY, []);
export const setPending = (list) => write(PENDING_KEY, list);
