import * as chrono from "https://cdn.jsdelivr.net/npm/chrono-node@2.10.1/+esm";
import { parseTasks, SPACES } from "./parse.js";

// ─── Settings ────────────────────────────────────────────────────────
// The Craft API URL is itself the secret: anyone holding it can write to that
// space. It is kept in this browser only, never in the repo.
const STORE_KEY = "tasks.settings";
const SPACE_COLOUR = { my: "var(--accent)", work: "var(--work)" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    return { spaces: s.spaces || {}, defaultSpace: s.defaultSpace || SPACES[0].id };
  } catch {
    return { spaces: {}, defaultSpace: SPACES[0].id };
  }
}
function saveSettings(s) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* private mode */ }
}
let settings = loadSettings();

// Only the link ID matters, so anything around it in a paste (a missing
// /api/v1, a trailing slash, a path copied from the docs) is ignored.
function apiBase(url) {
  const u = String(url || "").trim();
  const m = u.match(/^(?:https?:\/\/)?(connect\.craft\.do\/links\/[^/?#\s]+)/i);
  return m ? `https://${m[1]}/api/v1` : u.replace(/\/+$/, "");
}
const isConfigured = (id) => Boolean(settings.spaces[id]?.url);
// The Craft space ID from the last test is kept only while the URL is unchanged.
function withConfig(id, url, key) {
  const prev = settings.spaces[id] || {};
  const next = { url: url.trim(), key: key.trim() };
  if (prev.spaceUuid && prev.url === next.url) next.spaceUuid = prev.spaceUuid;
  return next;
}

async function craft(spaceId, path, options = {}) {
  const { url, key } = settings.spaces[spaceId] || {};
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  const resp = await fetch(apiBase(url) + path, { ...options, headers });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    let detail = body;
    try { detail = JSON.parse(body).error || JSON.parse(body).message || body; } catch { /* not JSON */ }
    const err = new Error(`${resp.status}${detail ? ` — ${String(detail).slice(0, 140)}` : ""}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

// ─── Review list ─────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const dictation = $("dictation");
const list = $("tasks");
const sendBtn = $("send");
let tasks = [];

const spaceLabel = (id) => SPACES.find(s => s.id === id)?.label || id;

function dateLabel(iso) {
  if (!iso) return "No date";
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((date - today) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  const opts = { weekday: "short", day: "numeric", month: "short" };
  if (date.getFullYear() !== today.getFullYear()) opts.year = "numeric";
  return date.toLocaleDateString("en-GB", opts);
}

function render() {
  const n = tasks.length;
  // The review list and the Add button only appear once something has been
  // dictated, so the Craft list below has the screen to itself until then.
  $("review-head").hidden = !n;
  $("tasks").hidden = !n;
  document.querySelector(".send-bar").hidden = !n;
  $("clear").hidden = !n && !dictation.value;
  $("review-title").textContent = n ? `${n} task${n === 1 ? "" : "s"}` : "Tasks";
  sendBtn.disabled = !n || tasks.some(t => !t.text.trim());
  sendBtn.textContent = n ? `Add ${n} task${n === 1 ? "" : "s"} to Craft` : "Add to Craft";

  if (!n) return;
  list.replaceChildren(...tasks.map((t, i) => {
    const el = document.createElement("div");
    el.className = "task";
    el.innerHTML = `
      <div class="task-top">
        <input class="task-text" aria-label="Task" enterkeyhint="done">
        <button class="remove" aria-label="Remove task">×</button>
      </div>
      <div class="task-meta">
        <button class="chip space-${t.space}" data-act="space" aria-label="Workspace, tap to switch"></button>
        <span class="chip ${t.date ? "has-date" : ""}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          <span class="date-label"></span>
          <input type="date" aria-label="Schedule date">
          ${t.date ? `<button class="clear" data-act="nodate" aria-label="Remove date">×</button>` : ""}
        </span>
      </div>`;
    const text = el.querySelector(".task-text");
    text.value = t.text;
    text.addEventListener("input", () => { t.text = text.value; sendBtn.disabled = tasks.some(x => !x.text.trim()); });
    el.querySelector("[data-act=space]").textContent = spaceLabel(t.space) + (isConfigured(t.space) ? "" : " · not set up");
    el.querySelector(".date-label").textContent = dateLabel(t.date);
    const picker = el.querySelector("input[type=date]");
    picker.value = t.date || "";
    picker.addEventListener("change", () => { t.date = picker.value || null; render(); });
    el.querySelector("[data-act=space]").addEventListener("click", () => {
      const idx = SPACES.findIndex(s => s.id === t.space);
      t.space = SPACES[(idx + 1) % SPACES.length].id;
      render();
    });
    el.querySelector("[data-act=nodate]")?.addEventListener("click", (e) => { e.stopPropagation(); t.date = null; render(); });
    el.querySelector(".remove").addEventListener("click", () => { tasks.splice(i, 1); render(); });
    return el;
  }));
}

// Re-read the dictation as it changes. Edits made in the list are kept until
// the dictation itself is changed again.
let parseTimer;
dictation.addEventListener("input", () => {
  clearTimeout(parseTimer);
  parseTimer = setTimeout(() => {
    tasks = parseTasks(dictation.value, chrono, { defaultSpace: settings.defaultSpace });
    render();
  }, 250);
});

$("clear").addEventListener("click", () => {
  dictation.value = "";
  tasks = [];
  render();
});

// ─── Sending ─────────────────────────────────────────────────────────
let toastTimer;
function toast(msg, kind = "ok") {
  const t = $("toast");
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = "toast"; }, kind === "err" ? 7000 : 3500);
}

sendBtn.addEventListener("click", async () => {
  const missing = [...new Set(tasks.map(t => t.space))].filter(id => !isConfigured(id));
  if (missing.length) {
    toast(`Set up ${missing.map(spaceLabel).join(" and ")} first`, "err");
    openSettings();
    return;
  }
  sendBtn.disabled = true;
  sendBtn.textContent = "Adding…";

  // One request per space. A space that fails keeps its tasks on screen so
  // nothing is lost; the ones that went through are removed.
  const bySpace = new Map();
  for (const t of tasks) bySpace.set(t.space, [...(bySpace.get(t.space) || []), t]);
  const failed = [];
  let added = 0;
  for (const [spaceId, group] of bySpace) {
    const body = {
      tasks: group.map(t => ({
        markdown: t.text.trim(),
        location: { type: "inbox" },
        ...(t.date ? { taskInfo: { scheduleDate: t.date } } : {}),
      })),
    };
    try {
      await craft(spaceId, "/tasks", { method: "POST", body: JSON.stringify(body) });
      added += group.length;
    } catch (err) {
      console.error(`Adding to ${spaceLabel(spaceId)} failed:`, err);
      failed.push({ spaceId, group, message: err instanceof TypeError ? "couldn’t reach Craft" : err.message });
    }
  }

  tasks = failed.flatMap(f => f.group);
  if (added) loadCraftTasks();
  // Once anything has gone through, re-reading the dictation would bring those
  // tasks back and add them twice, so it is cleared; failures stay in the list.
  if (added) dictation.value = "";
  if (!failed.length) {
    toast(`Added ${added} task${added === 1 ? "" : "s"} to Craft`);
  } else {
    const why = failed.map(f => `${spaceLabel(f.spaceId)}: ${f.message}`).join("; ");
    toast(`${added ? `Added ${added}, but ` : ""}couldn’t add to ${why}`, "err");
  }
  render();
});

// ─── Tasks already in Craft ──────────────────────────────────────────
// Both spaces at once: what is scheduled for today or earlier, what is
// coming up, and anything sitting in the inbox without a date. Reading and
// updating tasks is free, so this refreshes on load and after adding.

const SCOPES = ["active", "upcoming", "inbox"];
let craftTasks = [];   // { id, text, date, spaceId }
let loadingTasks = false;

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const dayDiff = (iso) => {
  if (!iso) return null;
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return Math.round((new Date(y, m - 1, d) - startOfToday()) / 86400000);
};
function dateText(iso) {
  const days = dayDiff(iso);
  if (days === null) return "";
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  const date = new Date(iso.slice(0, 10) + "T12:00");
  const opts = { weekday: "short", day: "numeric", month: "short" };
  if (date.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return `${days < -1 ? "" : ""}${date.toLocaleDateString("en-GB", opts)}`;
}
// Overdue, today and undated tasks are the ones worth acting on, so they sort
// to the top; everything else follows in date order.
const groupOf = (t) => {
  const days = dayDiff(t.date);
  if (days === null) return { key: "none", label: "No date", order: 3 };
  if (days < 0) return { key: "late", label: "Overdue", order: 0 };
  if (days === 0) return { key: "today", label: "Today", order: 1 };
  return { key: "later", label: "Coming up", order: 2 };
};

async function loadCraftTasks() {
  const spaces = SPACES.filter(s => isConfigured(s.id));
  if (!spaces.length) { craftTasks = []; renderCraftTasks(); return; }
  loadingTasks = true;
  renderCraftTasks();
  const found = new Map();
  const failed = [];
  await Promise.all(spaces.map(async (space) => {
    try {
      const lists = await Promise.all(SCOPES.map(scope => craft(space.id, `/tasks?scope=${scope}`)));
      for (const list of lists) {
        for (const item of list.items || []) {
          if (item.taskInfo?.state !== "todo") continue;
          found.set(item.id, {
            id: item.id,
            text: (item.markdown || "").replace(/^\s*[-*]\s*\[[ x]\]\s*/, "").trim(),
            date: item.taskInfo?.scheduleDate || null,
            spaceId: space.id,
          });
        }
      }
    } catch (err) {
      console.error(`Loading ${spaceLabel(space.id)} tasks failed:`, err);
      failed.push(spaceLabel(space.id));
    }
  }));
  craftTasks = [...found.values()];
  loadingTasks = false;
  renderCraftTasks();
  if (failed.length) toast(`Couldn’t load tasks from ${failed.join(" and ")}`, "err");
}

async function completeTask(task, row) {
  row.classList.add("done");
  try {
    await craft(task.spaceId, "/tasks", {
      method: "PUT",
      body: JSON.stringify({ tasksToUpdate: [{ id: task.id, taskInfo: { state: "done" } }] }),
    });
    // Leave it ticked for a moment so the change is visible, then drop it.
    setTimeout(() => {
      craftTasks = craftTasks.filter(t => t.id !== task.id);
      renderCraftTasks();
    }, 900);
  } catch (err) {
    console.error("Completing task failed:", err);
    row.classList.remove("done");
    toast(err instanceof TypeError ? "Couldn’t reach Craft" : `Couldn’t tick that off: ${err.message}`, "err");
  }
}

function renderCraftTasks() {
  const box = $("craft-tasks");
  const title = $("craft-title");
  $("refresh").hidden = !SPACES.some(s => isConfigured(s.id));
  if (!SPACES.some(s => isConfigured(s.id))) {
    title.textContent = "In Craft";
    box.innerHTML = `<p class="empty">Set up a Craft connection to see your tasks here.</p>`;
    return;
  }
  if (loadingTasks && !craftTasks.length) {
    title.textContent = "In Craft";
    box.innerHTML = `<p class="loading">Loading your tasks…</p>`;
    return;
  }
  title.textContent = craftTasks.length ? `In Craft · ${craftTasks.length}` : "In Craft";
  if (!craftTasks.length) {
    box.innerHTML = `<p class="empty">Nothing to do. Either you’re all caught up, or everything is scheduled further ahead.</p>`;
    return;
  }
  const sorted = [...craftTasks].sort((a, b) => {
    const ga = groupOf(a), gb = groupOf(b);
    return ga.order - gb.order || (a.date || "").localeCompare(b.date || "") || a.text.localeCompare(b.text);
  });
  box.replaceChildren();
  let lastGroup = null;
  for (const task of sorted) {
    const group = groupOf(task);
    if (group.key !== lastGroup) {
      lastGroup = group.key;
      const label = document.createElement("div");
      label.className = `group-label${group.key === "late" ? " late" : ""}`;
      label.textContent = group.label;
      box.append(label);
    }
    const row = document.createElement("div");
    row.className = "t-row";
    row.innerHTML = `<button class="tick" aria-label="Tick off"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></button>
      <div class="t-body"><div class="t-text"></div><div class="t-meta">
        <span class="t-space ${task.spaceId}"><span class="dot"></span>${esc(spaceLabel(task.spaceId))}</span>
        ${task.date ? `<span class="t-date${group.key === "late" ? " late" : ""}">${esc(dateText(task.date))}</span>` : ""}
      </div></div>`;
    row.querySelector(".t-text").textContent = task.text || "(no text)";
    row.querySelector(".tick").onclick = () => completeTask(task, row);
    box.append(row);
  }
}

$("refresh").addEventListener("click", loadCraftTasks);

// ─── Settings dialog ─────────────────────────────────────────────────
// Craft has three kinds of API connection and only two can manage tasks:
// "All Documents" and "Daily Notes and Tasks". "Selected Documents" answers
// 404 on /tasks, so a 404 is checked against /connection, which every kind
// has, to tell a wrong kind of connection apart from a wrong URL.
async function testConnection(spaceId) {
  let info;
  try {
    info = await craft(spaceId, "/connection");
  } catch (err) {
    if (err instanceof TypeError) return { ok: false, message: "Couldn’t reach Craft. Check the URL." };
    if (err.status === 401 || err.status === 403) return { ok: false, message: "Craft needs the API key for this connection, or the key is wrong." };
    if (err.status === 404) return { ok: false, message: "Craft doesn’t recognise this URL. Copy the API URL from Craft again." };
    // /connection is marked experimental by Craft; if it has changed, fall
    // through and let the tasks check decide.
  }
  try {
    const data = await craft(spaceId, "/tasks?scope=inbox");
    const count = data.items?.length ?? 0;
    settings.spaces[spaceId].spaceUuid = info?.space?.id;
    saveSettings(settings);
    const other = SPACES.find(s => s.id !== spaceId && info?.space?.id && settings.spaces[s.id]?.spaceUuid === info.space.id);
    if (other) return { ok: false, message: `Connected, but this is the same Craft space as ${other.label}.` };
    return { ok: true, message: `Connected · ${count} task${count === 1 ? "" : "s"} in the inbox` };
  } catch (err) {
    if (err instanceof TypeError) return { ok: false, message: "Couldn’t reach Craft. Check the URL." };
    if (err.status === 404 && info) return { ok: false, message: "This connection can’t add tasks. In Craft’s Imagine tab, create an “All Documents” or “Daily Notes and Tasks” connection instead of “Selected Documents”." };
    if (err.status === 401 || err.status === 403) return { ok: false, message: "Craft needs the API key for this connection, or the key is wrong." };
    return { ok: false, message: `Failed: ${err.message}` };
  }
}

const dialog = $("settings");

function openSettings() {
  const fields = $("space-fields");
  fields.replaceChildren(...SPACES.map(s => {
    const cfg = settings.spaces[s.id] || {};
    const box = document.createElement("div");
    box.className = "space-box";
    box.innerHTML = `
      <h3><span class="dot" style="background:${SPACE_COLOUR[s.id]}"></span></h3>
      <label class="f">API URL</label>
      <input class="field" data-k="url" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://connect.craft.do/links/…/api/v1">
      <label class="f">API key <span style="text-transform:none;font-weight:400">(only if you turned one on)</span></label>
      <input class="field" data-k="key" type="password" autocomplete="off" autocapitalize="off" spellcheck="false">
      <div class="row"><button type="button" class="btn">Test</button><span class="test-result"></span></div>`;
    box.querySelector("h3").append(s.label);
    const url = box.querySelector("[data-k=url]");
    const key = box.querySelector("[data-k=key]");
    url.value = cfg.url || "";
    key.value = cfg.key || "";
    const store = () => {
      settings.spaces[s.id] = withConfig(s.id, url.value, key.value);
      saveSettings(settings);
    };
    url.addEventListener("change", store);
    key.addEventListener("change", store);
    const result = box.querySelector(".test-result");
    box.querySelector(".btn").addEventListener("click", async () => {
      store();
      if (!url.value.trim()) { result.className = "test-result err"; result.textContent = "Paste the URL first"; return; }
      result.className = "test-result"; result.textContent = "Checking…";
      const { ok, message } = await testConnection(s.id);
      result.className = `test-result ${ok ? "ok" : "err"}`;
      result.textContent = message;
    });
    return box;
  }));
  const sel = $("default-space");
  sel.replaceChildren(...SPACES.map(s => new Option(s.label, s.id, false, s.id === settings.defaultSpace)));
  sel.onchange = () => { settings.defaultSpace = sel.value; saveSettings(settings); };
  dialog.showModal();
}

$("open-settings").addEventListener("click", openSettings);
dialog.addEventListener("close", () => {
  // Pick up anything typed without leaving the field.
  dialog.querySelectorAll(".space-box").forEach((box, i) => {
    const id = SPACES[i].id;
    settings.spaces[id] = withConfig(id, box.querySelector("[data-k=url]").value, box.querySelector("[data-k=key]").value);
  });
  saveSettings(settings);
  render();
  loadCraftTasks();
});

render();
loadCraftTasks();
if (!SPACES.some(s => isConfigured(s.id))) openSettings();
