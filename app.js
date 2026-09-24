import * as chrono from "https://cdn.jsdelivr.net/npm/chrono-node@2.10.1/+esm";
import { parseTasks, SPACES } from "./parse.js";
import * as todoist from "./todoist.js";

// ─── Settings ────────────────────────────────────────────────────────
// The Craft API URL is itself the secret: anyone holding it can write to that
// space. It is kept in this browser only, never in the repo.
const STORE_KEY = "tasks.settings";
const SPACE_COLOUR = { my: "var(--accent)", work: "var(--work)", todoist: "var(--joint)" };
const isTodoist = (id) => id === "todoist";
let projects = [];   // Todoist projects, for naming and for routing new tasks
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    return { spaces: s.spaces || {}, todoist: s.todoist || {}, defaultSpace: s.defaultSpace || SPACES[0].id, autoListen: s.autoListen !== false };
  } catch {
    return { spaces: {}, todoist: {}, defaultSpace: SPACES[0].id, autoListen: true };
  }
}
function saveSettings(s) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* private mode */ }
}
let settings = loadSettings();
todoist.setToken(settings.todoist?.token);

// Only the link ID matters, so anything around it in a paste (a missing
// /api/v1, a trailing slash, a path copied from the docs) is ignored.
function apiBase(url) {
  const u = String(url || "").trim();
  const m = u.match(/^(?:https?:\/\/)?(connect\.craft\.do\/links\/[^/?#\s]+)/i);
  return m ? `https://${m[1]}/api/v1` : u.replace(/\/+$/, "");
}
const isConfigured = (id) => isTodoist(id) ? Boolean(settings.todoist?.token) : Boolean(settings.spaces[id]?.url);
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
  // Same cleaning as the Todoist token: a pasted key can carry invisible
  // characters that a header cannot hold.
  const cleanKey = String(key || "").replace(/[\s\u00A0\u200B-\u200D\uFEFF]/g, "");
  if (cleanKey) headers.Authorization = `Bearer ${cleanKey}`;
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
  sendBtn.textContent = n ? `Add ${n} task${n === 1 ? "" : "s"}` : "Add";

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
    if (isTodoist(t.space) && t.project) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = t.project.name;
      el.querySelector(".task-meta").append(chip);
    }
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
function reparse() {
  tasks = parseTasks(dictation.value, chrono, { defaultSpace: settings.defaultSpace });
  routeTodoist();
  render();
}

// A Todoist task can name its project first ("joint house fix the gate"), so
// the project is split off here, before anything is shown, and the card then
// shows exactly what will be sent.
function routeTodoist() {
  if (!projects.length) return;
  for (const task of tasks) {
    if (!isTodoist(task.space)) continue;
    const { project, text } = todoist.pickProject(task.text, projects);
    task.text = text;
    task.project = project;
  }
}
dictation.addEventListener("input", () => {
  clearTimeout(parseTimer);
  parseTimer = setTimeout(reparse, 250);
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
  stopListening();
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
    try {
      if (isTodoist(spaceId)) {
        // Todoist adds one task per call, each to the project named in the
        // dictation or, failing that, the shared list.
        for (const t of group) {
          const project = t.project || todoist.pickProject(t.text.trim(), projects).project;
          await todoist.addTask({ text: t.text.trim(), date: t.date, projectId: project?.id });
        }
      } else {
        await craft(spaceId, "/tasks", {
          method: "POST",
          body: JSON.stringify({
            tasks: group.map(t => ({
              markdown: t.text.trim(),
              location: { type: "inbox" },
              ...(t.date ? { taskInfo: { scheduleDate: t.date } } : {}),
            })),
          }),
        });
      }
      added += group.length;
    } catch (err) {
      console.error(`Adding to ${spaceLabel(spaceId)} failed:`, err);
      failed.push({ spaceId, group, message: err instanceof TypeError ? `couldn’t reach ${isTodoist(spaceId) ? "Todoist" : "Craft"}` : err.message });
    }
  }

  tasks = failed.flatMap(f => f.group);
  if (added) loadCraftTasks();
  // Once anything has gone through, re-reading the dictation would bring those
  // tasks back and add them twice, so it is cleared; failures stay in the list.
  if (added) dictation.value = "";
  if (!failed.length) {
    toast(`Added ${added} task${added === 1 ? "" : "s"}`);
  } else {
    const why = failed.map(f => `${spaceLabel(f.spaceId)}: ${f.message}`).join("; ");
    toast(`${added ? `Added ${added}, but ` : ""}couldn’t add to ${why}`, "err");
  }
  render();
});


// ─── Speaking straight into the page ─────────────────────────────────
// The browser's own speech recognition, so there is a button to press
// instead of reaching for the keyboard's microphone. It never punctuates,
// so each finished phrase becomes its own line, which the parser treats as
// one task. iOS ends a session after a pause, so it is restarted until the
// button is pressed again.

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let recogniser = null;
let listening = false;

function paintMic() {
  $("mic").classList.toggle("on", listening);
  $("mic-label").textContent = listening ? "Stop" : "Start speaking";
  if (!listening) $("mic-said").textContent = "";
}

function startListening() {
  if (!SpeechRec || listening) return;
  recogniser = new SpeechRec();
  recogniser.lang = "en-GB";
  recogniser.continuous = true;
  recogniser.interimResults = true;
  recogniser.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const said = event.results[i][0].transcript.trim();
      if (!said) continue;
      if (event.results[i].isFinal) {
        dictation.value = dictation.value.trimEnd() + (dictation.value.trim() ? "\n" : "") + said;
        reparse();
      } else {
        interim = said;
      }
    }
    $("mic-said").textContent = interim;
  };
  recogniser.onerror = (event) => {
    if (event.error === "aborted" || event.error === "no-speech") return;
    stopListening();
    toast(event.error === "not-allowed"
      ? "Microphone access is off. Turn it on for this site in Safari’s settings."
      : `Speech didn’t work (${event.error}). Use the keyboard microphone instead.`, "err");
  };
  // A pause ends the session on iOS, so pick it straight back up.
  recogniser.onend = () => { if (listening) { try { recogniser.start(); } catch { /* already going */ } } };
  try {
    recogniser.start();
    listening = true;
  } catch {
    toast("Couldn’t start the microphone", "err");
  }
  paintMic();
}

function stopListening() {
  listening = false;
  try { recogniser?.stop(); } catch { /* already stopped */ }
  paintMic();
}

if (SpeechRec) {
  $("mic-row").hidden = false;
  $("mic").addEventListener("click", () => (listening ? stopListening() : startListening()));
  // Only when the microphone has already been allowed: browsers will not let
  // a page start listening on its own the first time.
  if (settings.autoListen !== false) {
    navigator.permissions?.query({ name: "microphone" })
      .then(status => { if (status.state === "granted") startListening(); })
      .catch(() => { /* Safari has no permissions API for this */ });
  }
}

// ─── Tasks already in Craft ──────────────────────────────────────────
// Both spaces at once: what is scheduled for today or earlier, what is
// coming up, and anything sitting in the inbox without a date. Reading and
// updating tasks is free, so this refreshes on load and after adding.

const SCOPES = ["active", "upcoming", "inbox"];
// A "Daily Notes and Tasks" connection can read tasks from anywhere but can
// only change the ones in the inbox and daily notes; Craft answers
// "document not in scope" for the rest. Such a connection has no /documents
// endpoint, which is how this tells the two apart.
const canEditDocs = {};
let craftTasks = [];   // { id, text, date, spaceId, where }
const openSections = (() => {
  try { return JSON.parse(localStorage.getItem("tasks.sections") || "{}"); } catch { return {}; }
})();
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
// Where a task lives, which is how the list is grouped. Inbox first, then
// daily notes newest first, then documents by name.
function placeOf(location) {
  if (location?.type === "document") return { key: `d:${location.title}`, label: location.title || "Untitled", rank: 2 };
  if (location?.type === "dailyNote") return { key: `n:${location.date}`, label: `Daily note · ${dateText(location.date)}`, rank: 1, date: location.date };
  return { key: "inbox", label: "Inbox", rank: 0 };
}
const isLate = (t) => { const d = dayDiff(t.date); return d !== null && d < 0; };

async function loadCraftTasks() {
  const spaces = SPACES.filter(s => !isTodoist(s.id) && isConfigured(s.id));
  if (!spaces.length) { craftTasks = []; renderCraftTasks(); return; }
  loadingTasks = true;
  renderCraftTasks();
  const found = new Map();
  const failed = [];
  const jobs = spaces.map(async (space) => {
    craft(space.id, "/documents?limit=1")
      .then(() => { canEditDocs[space.id] = true; })
      .catch(err => { if (err.status === 404) canEditDocs[space.id] = false; });
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
            where: placeOf(item.location),
          });
        }
      }
    } catch (err) {
      console.error(`Loading ${spaceLabel(space.id)} tasks failed:`, err);
      failed.push(spaceLabel(space.id));
    }
  });
  if (isConfigured("todoist")) {
    jobs.push((async () => {
      try {
        projects = await todoist.loadProjects();
        for (const task of await todoist.loadTasks(projects)) found.set(task.id, task);
      } catch (err) {
        console.error("Loading Todoist tasks failed:", err);
        failed.push("joint.");
      }
    })());
  }
  await Promise.all(jobs);
  routeTodoist();
  if (tasks.length) render();
  craftTasks = [...found.values()];
  loadingTasks = false;
  renderCraftTasks();
  if (failed.length) toast(`Couldn’t load tasks from ${failed.join(" and ")}`, "err");
}

// Craft and Todoist both take a plain YYYY-MM-DD. Neither offers a documented
// way to clear a date, so this only ever sets one.
async function reschedule(task, date, row) {
  const was = task.date;
  task.date = date;
  row.querySelector(".when-text").textContent = dateText(date);
  try {
    if (isTodoist(task.spaceId)) await todoist.rescheduleTask(task.id, date);
    else await craft(task.spaceId, "/tasks", {
      method: "PUT",
      body: JSON.stringify({ tasksToUpdate: [{ id: task.id, taskInfo: { scheduleDate: date } }] }),
    });
    toast(`${task.text} → ${dateText(date)}`);
    renderCraftTasks();
  } catch (err) {
    console.error("Changing the date failed:", err);
    task.date = was;
    renderCraftTasks();
    toast(/scope/i.test(err.message)
      ? scopeHelp(task.spaceId)
      : err instanceof TypeError ? "Couldn’t reach Craft or Todoist" : `Couldn’t change the date: ${err.message}`, "err");
  }
}

async function completeTask(task, row) {
  row.classList.add("done");
  try {
    if (isTodoist(task.spaceId)) await todoist.closeTask(task.id);
    else await craft(task.spaceId, "/tasks", {
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
    toast(err instanceof TypeError ? "Couldn’t reach Craft or Todoist"
      : /scope/i.test(err.message) ? scopeHelp(task.spaceId)
      : `Couldn’t tick that off: ${err.message}`, "err");
  }
}

const scopeHelp = (spaceId) =>
  `This task is inside a document, and the ${spaceLabel(spaceId)} connection can only change tasks in the inbox and daily notes. In Craft, create an “All Documents” connection for that space and paste its URL in the settings.`;

function renderCraftTasks() {
  const box = $("craft-tasks");
  const title = $("craft-title");
  const ready = SPACES.some(s => isConfigured(s.id));
  $("refresh").hidden = !ready;
  $("craft-head").hidden = !ready && !craftTasks.length;
  title.textContent = "";
  if (!ready) {
    box.innerHTML = `<p class="empty">Set up a Craft connection to see your tasks here.</p>`;
    return;
  }
  if (loadingTasks && !craftTasks.length) {
    box.innerHTML = `<p class="loading">Loading your tasks…</p>`;
    return;
  }
  if (!craftTasks.length) {
    box.innerHTML = `<p class="empty">Nothing to do. Either you’re all caught up, or everything is scheduled further ahead.</p>`;
    return;
  }
  // Anything overdue belongs with today: it still needs doing today.
  const due = (t) => { const d = dayDiff(t.date); return d !== null && d <= 0; };
  box.replaceChildren(
    fold("today", "today", craftTasks.filter(due)),
    fold("upcoming", "upcoming", craftTasks.filter(t => !due(t)), true),
  );
}

const bySpaceOrder = (a, b) =>
  SPACES.findIndex(s => s.id === a.spaceId) - SPACES.findIndex(s => s.id === b.spaceId);
const byDate = (a, b) => (a.date || "9999").localeCompare(b.date || "9999");

// today. is one day's worth, so it reads by space: my space., work., joint.
// upcoming. spans days, so the date leads and each day then reads in that
// same space order. Undated tasks sit at the end either way.
const inOrder = (list, dateFirst) => [...list].sort((a, b) =>
  (dateFirst ? byDate(a, b) || bySpaceOrder(a, b) : bySpaceOrder(a, b) || byDate(a, b)) ||
  a.text.localeCompare(b.text));

function fold(key, label, list, dateFirst = false) {
  const wrap = document.createElement("section");
  const closed = openSections[key] === false || (!list.length && openSections[key] !== true);
  wrap.className = `fold${closed ? " closed" : ""}`;
  wrap.innerHTML = `<button class="fold-head"><span class="fold-name">${esc(label)}<span class="dot">.</span></span>
      <span class="n">${list.length}</span>
      <svg class="chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
    </button><div class="fold-body"></div>`;
  const body = wrap.querySelector(".fold-body");
  if (!list.length) body.innerHTML = `<p class="empty">Nothing here.</p>`;
  else inOrder(list, dateFirst).forEach(task => body.append(taskRow(task)));
  wrap.querySelector(".fold-head").onclick = () => {
    openSections[key] = !wrap.classList.toggle("closed");
    try { localStorage.setItem("tasks.sections", JSON.stringify(openSections)); } catch { /* private mode */ }
  };
  return wrap;
}

function taskRow(task) {
  const row = document.createElement("div");
  row.className = "t-row";
  // The date is a label wrapping a real date input, so tapping it opens the
  // phone's own picker rather than a home-made one.
  row.innerHTML = `<button class="tick" aria-label="Tick off"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></button>
    <div class="t-body"><div class="t-text"></div><div class="t-meta">
      <span class="t-space ${task.spaceId}"><span class="dot"></span>${esc(spaceLabel(task.spaceId))}</span>
      <label class="t-when${isLate(task) ? " late" : ""}${task.date ? "" : " none"}">
        <span class="when-text">${esc(task.date ? dateText(task.date) : "Set a date")}</span>
        <input type="date" aria-label="Scheduled date">
      </label>
      <span class="t-doc">${esc(task.where.label)}</span>
    </div></div>`;
  row.querySelector(".t-text").textContent = task.text || "(no text)";
  const when = row.querySelector("input[type=date]");
  when.value = task.date || "";
  when.onchange = () => { if (when.value) reschedule(task, when.value, row); };
  const locked = !isTodoist(task.spaceId) && task.where.rank === 2 && canEditDocs[task.spaceId] === false;
  row.classList.toggle("locked", locked);
  row.querySelector(".tick").onclick = () => locked ? toast(scopeHelp(task.spaceId), "err") : completeTask(task, row);
  return row;
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

function todoistBox(space) {
  const box = document.createElement("div");
  box.className = "space-box";
  box.innerHTML = `
    <h3><span class="dot" style="background:${SPACE_COLOUR[space.id]}"></span></h3>
    <label class="f">Todoist API token</label>
    <input class="field" data-k="token" type="password" autocomplete="off" autocapitalize="off" spellcheck="false">
    <p class="note">Todoist → Settings → Integrations → Developer → API token. Dictated tasks go to ${todoist.DEFAULT_PROJECT} unless you say another project's name first.</p>
    <div class="row"><button type="button" class="btn">Test</button><span class="test-result"></span></div>`;
  box.querySelector("h3").append(space.label);
  const token = box.querySelector("[data-k=token]");
  token.value = settings.todoist?.token || "";
  const store = () => {
    settings.todoist = { token: token.value.trim() };
    todoist.setToken(settings.todoist.token);
    saveSettings(settings);
  };
  token.addEventListener("change", store);
  const result = box.querySelector(".test-result");
  box.querySelector(".btn").addEventListener("click", async () => {
    store();
    if (!token.value.trim()) { result.className = "test-result err"; result.textContent = "Paste the token first"; return; }
    result.className = "test-result"; result.textContent = "Checking…";
    try {
      projects = await todoist.loadProjects();
      result.className = "test-result ok";
      result.textContent = `Connected · ${projects.length} project${projects.length === 1 ? "" : "s"}`;
    } catch (err) {
      result.className = "test-result err";
      // The underlying message matters here: a blocked request reads very
      // differently from a refused one, and only the device shows which.
      result.textContent = err instanceof TypeError ? `Couldn’t reach Todoist — ${err.name}: ${err.message}` : err.message;
    }
  });
  return box;
}

function openSettings() {
  const fields = $("space-fields");
  fields.replaceChildren(...SPACES.map(s => {
    if (isTodoist(s.id)) return todoistBox(s);
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
  const auto = $("auto-listen");
  auto.checked = settings.autoListen !== false;
  auto.disabled = !SpeechRec;
  auto.onchange = () => { settings.autoListen = auto.checked; saveSettings(settings); };
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
    const token = box.querySelector("[data-k=token]");
    if (token) {
      settings.todoist = { token: token.value.trim() };
      todoist.setToken(settings.todoist.token);
      return;
    }
    settings.spaces[id] = withConfig(id, box.querySelector("[data-k=url]").value, box.querySelector("[data-k=key]").value);
  });
  saveSettings(settings);
  render();
  loadCraftTasks();
});

render();
loadCraftTasks();
if (!SPACES.some(s => isConfigured(s.id))) openSettings();
