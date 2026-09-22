import * as chrono from "https://cdn.jsdelivr.net/npm/chrono-node@2.10.1/+esm";
import { parseTasks, SPACES } from "./parse.js";

// ─── Settings ────────────────────────────────────────────────────────
// The Craft API URL is itself the secret: anyone holding it can write to that
// space. It is kept in this browser only, never in the repo.
const STORE_KEY = "tasks.settings";
const SPACE_COLOUR = { my: "var(--accent)", work: "var(--work)" };

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

// Accepts the URL as Craft shows it, with or without /api/v1 or a trailing
// slash, so a slightly different paste still works.
function apiBase(url) {
  const u = String(url || "").trim().replace(/\/+$/, "");
  if (!u) return "";
  return /\/api\/v\d+$/.test(u) ? u : `${u}/api/v1`;
}
const isConfigured = (id) => Boolean(settings.spaces[id]?.url);

async function craft(spaceId, path, options = {}) {
  const { url, key } = settings.spaces[spaceId] || {};
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  const resp = await fetch(apiBase(url) + path, { ...options, headers });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    let detail = body;
    try { detail = JSON.parse(body).error || JSON.parse(body).message || body; } catch { /* not JSON */ }
    throw new Error(`${resp.status}${detail ? ` — ${String(detail).slice(0, 140)}` : ""}`);
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
  $("clear").hidden = !n && !dictation.value;
  $("review-title").textContent = n ? `${n} task${n === 1 ? "" : "s"}` : "Tasks";
  sendBtn.disabled = !n || tasks.some(t => !t.text.trim());
  sendBtn.textContent = n ? `Add ${n} task${n === 1 ? "" : "s"} to Craft` : "Add to Craft";

  if (!n) {
    list.innerHTML = `<p class="empty">Your tasks will appear here to check before they’re added.</p>`;
    return;
  }
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

// ─── Settings dialog ─────────────────────────────────────────────────
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
      settings.spaces[s.id] = { url: url.value.trim(), key: key.value.trim() };
      saveSettings(settings);
    };
    url.addEventListener("change", store);
    key.addEventListener("change", store);
    const result = box.querySelector(".test-result");
    box.querySelector(".btn").addEventListener("click", async () => {
      store();
      if (!url.value.trim()) { result.className = "test-result err"; result.textContent = "Paste the URL first"; return; }
      result.className = "test-result"; result.textContent = "Checking…";
      try {
        const data = await craft(s.id, "/tasks?scope=inbox");
        const count = data.items?.length ?? 0;
        result.className = "test-result ok";
        result.textContent = `Connected · ${count} task${count === 1 ? "" : "s"} in the inbox`;
      } catch (err) {
        result.className = "test-result err";
        result.textContent = err instanceof TypeError ? "Couldn’t reach Craft — check the URL" : `Failed: ${err.message}`;
      }
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
    settings.spaces[id] = {
      url: box.querySelector("[data-k=url]").value.trim(),
      key: box.querySelector("[data-k=key]").value.trim(),
    };
  });
  saveSettings(settings);
  render();
});

render();
if (!SPACES.some(s => isConfigured(s.id))) openSettings();
