import { parseTasks, SPACES } from "/lifeos/shared/parse.js?v=25";
import * as todoist from "/lifeos/shared/todoist.js?v=25";
import * as gcal from "./calendar.js?v=26";
import * as speech from "/lifeos/shared/speech.js?v=25";
import * as hub from "/lifeos/shared/hubtasks.js?v=25";
import * as rep from "/lifeos/shared/repeat.js?v=25";
import { pullToRefresh } from "/lifeos/shared/pull.js?v=25";

// ─── Settings ────────────────────────────────────────────────────────
// The Craft API URL is itself the secret: anyone holding it can write to that
// space. It is kept in this browser only, never in the repo.

// tasks.: your tasks from lifeOS, Craft and Todoist, with dictation, priorities, repeats and time blocks.
// Runs inside lifeOS or on its own page (index.html), through /lifeos/embed.js.
// The code is the app as it was on its own page; `document` below is
// embed.js's stand-in, which looks inside this app's shadow root.
import { fill, docFor } from "/lifeos/embed.js";

export async function mount(ctx) {
  const { root, host, asset } = ctx;
  await fill(root, { css: asset("./app.css"), html: asset("./app.html") });
  const document = docFor(ctx);

  const STORE_KEY = "tasks.settings";
  // The date reader (200 KB) is only needed once something is typed or said,
  // so it loads alongside the page instead of holding it up.
  let chrono = null;
  const chronoReady = import("https://cdn.jsdelivr.net/npm/chrono-node@2.10.1/+esm").then(m => { chrono = m; });
  const SPACE_COLOUR = { my: "var(--accent)", work: "var(--work)", todoist: "var(--joint)" };
  const isTodoist = (id) => id === "todoist";
  let projects = [];   // Todoist projects, for naming and for routing new tasks
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
      return { spaces: s.spaces || {}, todoist: s.todoist || {}, google: s.google || {}, defaultSpace: s.defaultSpace || SPACES[0].id };
    } catch {
      return { spaces: {}, todoist: {}, google: {}, defaultSpace: SPACES[0].id };
    }
  }
  function saveSettings(s) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* private mode */ }
  }
  let settings = loadSettings();
  todoist.setToken(settings.todoist?.token);
  // Google's client is calendar.'s unless one is set here.
  const clientId = () => settings.google?.clientId || gcal.calendarClientId();

  // Only the link ID matters, so anything around it in a paste (a missing
  // /api/v1, a trailing slash, a path copied from the docs) is ignored.
  function apiBase(url) {
    const u = String(url || "").trim();
    const m = u.match(/^(?:https?:\/\/)?(connect\.craft\.do\/links\/[^/?#\s]+)/i);
    return m ? `https://${m[1]}/api/v1` : u.replace(/\/+$/, "");
  }
  // A space trying lifeOS tasks (switched in connections.) counts as having no
  // connection, though it stays saved.
  const isConfigured = (id) => !hub.inLifeosMode(id) && (isTodoist(id) ? Boolean(settings.todoist?.token) : Boolean(settings.spaces[id]?.url));
  // That switch is kept with the account; fetched once per visit, before the first load.
  let modeSynced = null;
  // A space with no Craft or Todoist connection on this device keeps its tasks
  // in lifeOS (lifeos/shared/hubtasks.js), so every space can always take tasks.
  const inLifeos = (id) => hub.sourceOf(settings, id) === "lifeos";
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
  // The traffic light: 3 high (red), 2 medium (amber), 1 low (green), 0 none.
  const PRIORITY = ["None", "Low", "Medium", "High"];
  const LIGHT = `<span class="light"></span>`;

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
    sendBtn.hidden = !n;
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
          ${t.repeat ? `<span class="chip has-date" title="Repeats">↻ <span class="rep-label"></span><button class="clear" data-act="norepeat" aria-label="Stop it repeating">×</button></span>` : ""}
          <button class="chip prio p${t.priority || 0}" data-act="prio" aria-label="Priority, tap to change">${LIGHT}<span>${t.priority ? PRIORITY[t.priority] : "Priority"}</span></button>
          <span class="chip ${t.time ? "has-date" : ""}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>
            <span class="time-label"></span>
            <input type="time" step="900" aria-label="Time to block out">
            ${t.time ? `<button class="clear" data-act="notime" aria-label="Remove time">×</button>` : ""}
          </span>
        </div>`;
      const text = el.querySelector(".task-text");
      text.value = t.text;
      text.addEventListener("input", () => { t.text = text.value; sendBtn.disabled = tasks.some(x => !x.text.trim()); });
      el.querySelector("[data-act=space]").textContent = spaceLabel(t.space);
      if (isTodoist(t.space) && !inLifeos(t.space) && t.project) {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = t.project.name;
        el.querySelector(".task-meta").append(chip);
      }
      el.querySelector(".date-label").textContent = dateLabel(t.date);
      const picker = el.querySelector("input[type=date]");
      picker.value = t.date || "";
      picker.addEventListener("change", () => { t.date = picker.value || null; if (!t.date) t.time = null; render(); });
      el.querySelector(".time-label").textContent = t.time ? `${t.time}${t.minutes && t.minutes !== gcal.DEFAULT_MINUTES ? ` · ${lengthText(t.minutes)}` : ""}` : "Add time";
      const clock = el.querySelector("input[type=time]");
      clock.value = t.time || "";
      // A time needs a day, so it brings today along when there isn't one.
      clock.addEventListener("change", () => { t.time = clock.value || null; if (t.time && !t.date) t.date = isoDay(new Date()); render(); });
      el.querySelector("[data-act=space]").addEventListener("click", () => {
        const idx = SPACES.findIndex(s => s.id === t.space);
        t.space = SPACES[(idx + 1) % SPACES.length].id;
        render();
      });
      if (t.repeat) el.querySelector(".rep-label").textContent = rep.describe(t.repeat);
      el.querySelector("[data-act=norepeat]")?.addEventListener("click", (e) => { e.stopPropagation(); t.repeat = null; render(); });
      // Taps go high → medium → low → none, the order most tasks are sorted in.
      el.querySelector("[data-act=prio]").addEventListener("click", () => {
        t.priority = [3, 0, 1, 2][t.priority || 0];
        render();
      });
      el.querySelector("[data-act=nodate]")?.addEventListener("click", (e) => { e.stopPropagation(); t.date = null; t.time = null; render(); });
      el.querySelector("[data-act=notime]")?.addEventListener("click", (e) => { e.stopPropagation(); t.time = null; render(); });
      el.querySelector(".remove").addEventListener("click", () => { tasks.splice(i, 1); render(); });
      return el;
    }));
  }

  const lengthText = (m) => m % 60 ? (m > 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`) : `${m / 60}h`;

  // Re-read the dictation as it changes. Edits made in the list are kept until
  // the dictation itself is changed again.
  let parseTimer;
  function reparse() {
    if (!chrono) { chronoReady.then(reparse); return; }
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
  // An action ({ label, run }) adds a button, e.g. Undo, and keeps it up longer.
  function toast(msg, kind = "ok", action = null) {
    const t = $("toast");
    t.replaceChildren();
    const text = document.createElement("span");
    text.className = "t-msg";
    text.textContent = msg;
    t.append(text);
    if (action) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "t-act"; b.textContent = action.label;
      b.onclick = () => { t.className = "toast"; action.run(); };
      t.append(b);
    }
    t.className = `toast show ${kind}${action ? " has-action" : ""}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = "toast"; }, action ? 6000 : kind === "err" ? 7000 : 3500);
  }

  sendBtn.addEventListener("click", async () => {
    stopListening();
    dictation.blur();
    sendBtn.disabled = true;
    sendBtn.textContent = "Adding…";

    // One request per space. A space that fails keeps its tasks on screen so
    // nothing is lost; the ones that went through are removed.
    const bySpace = new Map();
    for (const t of tasks) {
      const key = inLifeos(t.space) ? "lifeos" : t.space;
      bySpace.set(key, [...(bySpace.get(key) || []), t]);
    }
    const failed = [];
    let added = 0;
    // Tasks given a time, each with its new ID where the API handed one back.
    const timed = [];
    // What went in, shown in the list straight away; the reload that follows
    // replaces them with what each service sends back.
    const fresh = [];
    // Craft tasks given a priority: Craft has none, so lifeOS keeps it.
    const lit = [];
    // Spaces in Craft, which can't be given a repeat from here.
    const noRepeat = [];
    const owe = (t, id, spaceId) => { if (t.time && t.date) timed.push({ id: id ? String(id) : null, text: t.text.trim(), spaceId, date: t.date, time: t.time, minutes: t.minutes || gcal.DEFAULT_MINUTES }); };
    for (const [spaceId, group] of bySpace) {
      try {
        if (spaceId === "lifeos") {
          // Every space kept in lifeOS goes in one request.
          // A date changed by hand restarts the repeat from there.
          const made = await hub.addTasks(group.map(t => {
            const r = t.repeat ? rep.withAnchor(t.repeat, t.date) : null;
            return { text: t.text, date: r ? r.date : t.date, spaceId: t.space, priority: t.priority, repeat: r?.rule || null };
          }));
          group.forEach((t, i) => owe(t, made[i]?.id, t.space));
          fresh.push(...made);
        } else if (isTodoist(spaceId)) {
          // Todoist adds one task per call, each to the project named in the
          // dictation or, failing that, the shared list.
          for (const t of group) {
            const project = t.project || todoist.pickProject(t.text.trim(), projects).project;
            const made = await todoist.addTask({ text: t.text.trim(), date: t.date, projectId: project?.id, priority: t.priority, repeatText: t.repeat?.text });
            owe(t, made?.id, spaceId);
            if (made?.id) fresh.push({ id: String(made.id), text: t.text.trim(), date: (made.due?.date || t.date || "").slice(0, 10) || null, recurring: Boolean(made.due?.is_recurring), due: made.due || null,
              priority: t.priority || 0, spaceId: "todoist", where: { key: `p:${made.project_id}`, label: project?.name || "Todoist", rank: 2, projectId: String(made.project_id || "") } });
          }
        } else {
          if (group.some(t => t.repeat)) noRepeat.push(spaceLabel(spaceId));
          const made = await craft(spaceId, "/tasks", {
            method: "POST",
            body: JSON.stringify({
              tasks: group.map(t => ({
                markdown: t.text.trim(),
                location: { type: "inbox" },
                ...(t.date ? { taskInfo: { scheduleDate: t.date } } : {}),
              })),
            }),
          });
          // Craft doesn't document what it returns, so the IDs are used only
          // when there is one per task; otherwise the task is found by its text.
          const ids = (made?.items || made?.tasks || (Array.isArray(made) ? made : [])).map(x => x?.id);
          group.forEach((t, i) => {
            const id = ids.length === group.length ? ids[i] : null;
            owe(t, id, spaceId);
            fresh.push({ id: id ? String(id) : `tmp-${Date.now()}-${i}`, text: t.text.trim(), prefix: "", date: t.date || null, recurring: false,
              priority: t.priority || 0, spaceId, where: placeOf({ type: "inbox" }) });
            if (t.priority) lit.push({ id: id ? String(id) : null, text: t.text.trim(), spaceId, priority: t.priority });
          });
        }
        added += group.length;
      } catch (err) {
        console.error(`Adding to ${spaceLabel(spaceId)} failed:`, err);
        failed.push({ spaceId, group, message: err instanceof TypeError ? `couldn’t reach ${spaceId === "lifeos" ? "lifeOS" : isTodoist(spaceId) ? "Todoist" : "Craft"}` : err.message });
      }
    }

    tasks = failed.flatMap(f => f.group);
    if (fresh.length) {
      craftTasks = [...craftTasks.filter(t => !fresh.some(f => f.id === t.id)), ...fresh];
      renderCraftTasks();
    }
    const reload = added ? loadCraftTasks() : null;
    // Once anything has gone through, re-reading the dictation would bring those
    // tasks back and add them twice, so it is cleared; failures stay in the list.
    if (added) dictation.value = "";
    if (!failed.length && noRepeat.length) {
      toast(`Added ${added}. Craft tasks can’t repeat from here, so ${noRepeat.join(" and ")} got them without the repeat.`, "err");
    } else if (!failed.length) {
      toast(`Added ${added} task${added === 1 ? "" : "s"}`);
    } else {
      const why = failed.map(f => `${f.spaceId === "lifeos" ? "lifeOS" : spaceLabel(f.spaceId)}: ${f.message}`).join("; ");
      toast(`${added ? `Added ${added}, but ` : ""}couldn’t add to ${why}`, "err");
    }
    render();
    if (timed.length || lit.length) await reload;
    if (lit.length) lightCraftTasks(lit);
    if (timed.length) placeBlocks(timed);
  });

  // ─── Time blocks ─────────────────────────────────────────────────────
  // A task with a time has a block on the main calendar, made the way
  // calendar. makes them (see calendar.js), so it shows there too.
  let blocks = new Map();   // task ID → its block that isn't done

  // A block's time shows on the task while the two are on the same day.
  const timeOf = (task) => { const b = blocks.get(task.id); return b && b.day === task.date ? gcal.hhmm(b.start) : ""; };
  const whenText = (task) => task.date ? dateText(task.date) + (timeOf(task) ? ` · ${timeOf(task)}` : "") : "Set a date";

  async function loadBlocks() {
    if (!gcal.isConnected()) return;
    try {
      blocks = await gcal.loadBlocks();
      renderCraftTasks();
    } catch (err) {
      console.error("Loading time blocks failed:", err);
    }
  }

  // Blocks for tasks just added. Without a Google sign-in they wait on this
  // device, and a quiet trip through Google fetches one where it can.
  async function placeBlocks(list) {
    if (!gcal.isConnected()) {
      gcal.setPending([...gcal.pending(), ...list]);
      if (clientId() && gcal.wasConnected() && !gcal.silentTried()) { gcal.connect(clientId(), { silent: true }); return; }
      toast("Added. To block out the time on your calendar, connect Google Calendar in settings.", "err");
      return;
    }
    let made = 0;
    const failed = [];
    for (const item of list) {
      const task = (item.id && craftTasks.find(t => t.id === item.id && t.spaceId === item.spaceId))
        || craftTasks.find(t => t.spaceId === item.spaceId && t.text === item.text && !blocks.has(t.id))
        || (item.id ? { id: item.id, text: item.text, spaceId: item.spaceId } : null);
      if (!task) { failed.push(item.text); continue; }
      try {
        blocks.set(task.id, await gcal.createBlock(task, item.date, item.time, item.minutes));
        made++;
      } catch (err) {
        console.error("Blocking out time failed:", err);
        failed.push(item.text);
        if (err.status === 401) { gcal.setPending([...gcal.pending(), item]); }
      }
    }
    renderCraftTasks();
    if (failed.length) toast(`Couldn’t block out time for ${failed.join(", ")}`, "err");
    else if (made) toast(`Blocked out ${made === 1 ? `${list[0].time} for ${list[0].text}` : `time for ${made} tasks`}`);
  }

  // Blocks that were waiting for a sign-in.
  function placePending() {
    const list = gcal.pending();
    if (!list.length || !gcal.isConnected()) return;
    gcal.setPending([]);
    placeBlocks(list);
  }

  // A task moved to another day takes its block with it, at the same time,
  // as calendar. does.
  async function followTask(task, date) {
    const b = blocks.get(task.id);
    if (!b || b.day === date) return;
    try {
      blocks.set(task.id, await gcal.moveBlock(b, date));
    } catch (err) {
      console.error("Moving the time block failed:", err);
      toast(`Moved ${task.text}, but not its time block on the calendar`, "err");
    }
  }


  // ─── Speaking straight into the page ─────────────────────────────────
  // The browser's own speech recognition (lifeos/shared/speech.js), so there
  // is a button to press instead of reaching for the keyboard's microphone.
  // Each finished phrase becomes its own line, which the parser treats as one
  // task, and it keeps listening until the button is pressed again.

  const mic = speech.listener(dictation, {
    onChange: reparse,
    onInterim: (said) => { $("mic-said").textContent = said; },
    onState: (on) => {
      $("mic").classList.toggle("on", on);
      $("mic-label").textContent = on ? "Stop" : "Start speaking";
    },
    onError: (message) => toast(message, "err"),
  });
  const stopListening = () => mic.stop();

  if (speech.supported) {
    $("mic").hidden = false;
    $("mic-said").hidden = false;
    $("mic").addEventListener("click", () => (mic.listening ? mic.stop() : mic.start()));
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
  let doneTasks = [];    // lifeOS tasks ticked off this past week, newest first (done. section)
  const openSections = (() => {
    try { return JSON.parse(localStorage.getItem("tasks.sections") || "{}"); } catch { return {}; }
  })();
  let loadingTasks = false;
  // Lists switched off in the filter. Kept as the ones hidden, so a list set up
  // later shows by default.
  let highOnly = (() => { try { return localStorage.getItem("tasks.highOnly") === "1"; } catch { return false; } })();
  const hiddenSpaces = new Set((() => {
    try { return JSON.parse(localStorage.getItem("tasks.hidden") || "[]"); } catch { return []; }
  })());

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
    if (location?.type === "document") return { key: `d:${location.title}`, label: location.title || "Untitled", rank: 2, docId: location.documentId || location.id };
    if (location?.type === "dailyNote") return { key: `n:${location.date}`, label: `Daily note · ${dateText(location.date)}`, rank: 1, date: location.date };
    return { key: "inbox", label: "Inbox", rank: 0 };
  }
  const isLate = (t) => { const d = dayDiff(t.date); return d !== null && d < 0; };

  // Craft's dated lists and its inbox leave out a task in a document with no
  // date, so those come from the whole-space list ("all"), which also holds
  // done tasks and anything in the trash or a template; those are dropped.
  // A connection that can't see documents has no such list, which is fine.
  // The trash and templates hardly change, so their document lists are kept on
  // this device for a day (Refresh fetches them again): two requests fewer per
  // space on each open.
  let skipFresh = false;
  async function skipDocs(spaceId) {
    const key = `tasks.skip.${spaceId}`;
    try {
      const saved = JSON.parse(localStorage.getItem(key) || "null");
      if (!skipFresh && saved && Date.now() - saved.at < 86400000 && saved.url === settings.spaces[spaceId]?.url) return new Set(saved.ids);
    } catch { /* fetch them */ }
    const [trash, templates] = await Promise.all([
      craft(spaceId, "/documents?location=trash"),
      craft(spaceId, "/documents?location=templates"),
    ]);
    const ids = [...(trash.items || []), ...(templates.items || [])].map(d => d.id);
    try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), url: settings.spaces[spaceId]?.url, ids })); } catch { /* private mode */ }
    return new Set(ids);
  }

  async function undatedDocTasks(spaceId) {
    try {
      const [all, skip] = await Promise.all([craft(spaceId, "/tasks?scope=all"), skipDocs(spaceId)]);
      return (all.items || []).filter(i => i.taskInfo?.state === "todo" && i.location?.type === "document" && !skip.has(i.location.documentId));
    } catch (err) {
      if (err.status !== 404) console.error(`Loading undated ${spaceLabel(spaceId)} tasks failed:`, err);
      return [];
    }
  }

  async function loadCraftTasks() {
    await (modeSynced ||= hub.syncMode());
    const spaces = SPACES.filter(s => !isTodoist(s.id) && isConfigured(s.id));
    loadingTasks = true;
    renderCraftTasks();
    const blocksJob = loadBlocks();
    const found = new Map();
    const failed = [];
    // Sources that didn't load keep what was showing for them (the copy saved
    // on this device), rather than looking empty.
    const failedIds = new Set();
    const jobs = spaces.map(async (space) => {
      craft(space.id, "/documents?limit=1")
        .then(() => { canEditDocs[space.id] = true; })
        .catch(err => { if (err.status === 404) canEditDocs[space.id] = false; });
      try {
        const [lists, undated] = await Promise.all([
          Promise.all(SCOPES.map(scope => craft(space.id, `/tasks?scope=${scope}`))),
          undatedDocTasks(space.id),
        ]);
        for (const list of [...lists, { items: undated }]) {
          for (const item of list.items || []) {
            if (item.taskInfo?.state !== "todo") continue;
            const markdown = item.markdown || "";
            found.set(item.id, {
              id: item.id,
              text: markdown.replace(/^\s*[-*]\s*\[[ x]\]\s*/, "").trim(),
              // Any checkbox prefix Craft sent, so a rename goes back in the same shape.
              prefix: (markdown.match(/^\s*[-*]\s*\[[ x]\]\s*/) || [""])[0],
              date: item.taskInfo?.scheduleDate || null,
              // The task list puts repeat beside taskInfo, not in it as edits do.
              recurring: Boolean(item.repeat || item.taskInfo?.repeat),
              priority: 0,
              spaceId: space.id,
              where: placeOf(item.location),
            });
          }
        }
      } catch (err) {
        console.error(`Loading ${spaceLabel(space.id)} tasks failed:`, err);
        failed.push(spaceLabel(space.id));
        failedIds.add(space.id);
      }
    });
    // Craft has no priority, so lifeOS keeps a light for each Craft task given one.
    let craftLights = new Map();
    if (spaces.length) jobs.push(hub.loadCraftPriorities()
      .then(map => { craftLights = map; })
      .catch(err => console.error("Loading Craft priorities failed:", err)));
    jobs.push(hub.loadDone()
      .then(list => { doneTasks = list; })
      .catch(err => console.error("Loading done tasks failed:", err)));
    // Tasks kept in lifeOS show whatever is connected here.
    jobs.push(hub.loadTasks()
      .then(list => { for (const task of list) found.set(task.id, task); })
      .catch(err => { console.error("Loading lifeOS tasks failed:", err); failed.push("lifeOS"); failedIds.add("lifeos"); }));
    if (isConfigured("todoist")) {
      jobs.push((async () => {
        try {
          projects = await todoist.loadProjects();
          for (const task of await todoist.loadTasks(projects)) found.set(task.id, task);
        } catch (err) {
          console.error("Loading Todoist tasks failed:", err);
          failed.push("joint.");
          failedIds.add("todoist");
        }
      })());
    }
    await Promise.all([...jobs, blocksJob]);
    routeTodoist();
    if (tasks.length) render();
    for (const t of found.values()) {
      if (!t.builtin && !isTodoist(t.spaceId)) t.priority = craftLights.get(hub.craftKey(t.spaceId, t.id)) || 0;
    }
    for (const t of craftTasks) {
      if (!found.has(t.id) && failedIds.has(t.builtin ? "lifeos" : t.spaceId)) found.set(t.id, t);
    }
    craftTasks = [...found.values()];
    loadingTasks = false;
    skipFresh = false;
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
      if (task.builtin) await hub.rescheduleTask(task.id, date);
      else if (isTodoist(task.spaceId)) await todoist.rescheduleTask(task, date);
      else await craft(task.spaceId, "/tasks", {
        method: "PUT",
        body: JSON.stringify({ tasksToUpdate: [{ id: task.id, taskInfo: { scheduleDate: date } }] }),
      });
      await followTask(task, date);
      toast(`${task.text} → ${whenText(task)}`);
      renderCraftTasks();
      return true;
    } catch (err) {
      console.error("Changing the date failed:", err);
      task.date = was;
      renderCraftTasks();
      toast(/scope/i.test(err.message)
        ? scopeHelp(task.spaceId)
        : err instanceof TypeError ? "Couldn’t reach Craft, Todoist or lifeOS" : `Couldn’t change the date: ${err.message}`, "err");
      return false;
    }
  }

  async function completeTask(task, row) {
    if (String(task.id).startsWith("tmp-")) { toast("Still saving that one. Try again in a moment.", "err"); return; }
    row.classList.add("done");
    const prevDate = task.date, prevDue = task.due;
    // Marks this tick, so an Undo before the row leaves stops it leaving.
    const tickedAt = task.tickedAt = Date.now();
    let tick = {};
    try {
      if (task.builtin) {
        // A repeating one moves to its next date (its time block too) and stays.
        tick = await hub.completeTask(task);
        if (tick.next) {
          await followTask(task, tick.next);
          task.date = tick.next;
          toast(`${task.text} → next ${dateText(tick.next)}`, "ok", { label: "Undo", run: () => untick(task, { ...tick, prevDate }) });
          setTimeout(renderCraftTasks, 700);
          return;
        }
      } else if (isTodoist(task.spaceId)) await todoist.closeTask(task.id);
      else await craft(task.spaceId, "/tasks", {
        method: "PUT",
        body: JSON.stringify({ tasksToUpdate: [{ id: task.id, taskInfo: { state: "done" } }] }),
      });
      if (task.builtin) doneTasks = [{ ...task, doneAt: new Date().toISOString() }, ...doneTasks.filter(t => t.id !== task.id)];
      toast(`Ticked off ${task.text}`, "ok", { label: "Undo", run: () => untick(task, { ...tick, prevDate, prevDue }) });
      // Leave it ticked for a moment so the change is visible, then drop it.
      setTimeout(() => {
        if (task.tickedAt !== tickedAt) return;
        craftTasks = craftTasks.filter(t => t.id !== task.id);
        renderCraftTasks();
      }, 900);
    } catch (err) {
      console.error("Completing task failed:", err);
      row.classList.remove("done");
      toast(err instanceof TypeError ? "Couldn’t reach Craft, Todoist or lifeOS"
        : /scope/i.test(err.message) ? scopeHelp(task.spaceId)
        : `Couldn’t tick that off: ${err.message}`, "err");
    }
  }

  // Undo for a tick: open again (or, for a repeating one, back to its date).
  async function untick(task, { prevDate, prevDue, next, logId }) {
    task.tickedAt = null;
    try {
      if (task.builtin) {
        await hub.undoComplete(task, { prevDate, next, logId });
        if (next) await followTask(task, prevDate);
      } else if (isTodoist(task.spaceId)) {
        // A repeating Todoist task moved on when closed; put its date back.
        if (task.recurring && prevDue) await todoist.rescheduleTask({ ...task, due: prevDue }, prevDate);
        else await todoist.reopenTask(task.id);
      } else {
        await craft(task.spaceId, "/tasks", { method: "PUT", body: JSON.stringify({ tasksToUpdate: [{ id: task.id, taskInfo: { state: "todo" } }] }) });
      }
      task.date = prevDate;
      if (prevDue) task.due = prevDue;
      doneTasks = doneTasks.filter(t => t.id !== task.id);
      if (!craftTasks.includes(task)) craftTasks = [...craftTasks, task];
      renderCraftTasks();
      toast(`${task.text} is back`);
    } catch (err) {
      console.error("Undo failed:", err);
      toast(`Couldn’t undo: ${err.message}`, "err");
    }
  }

  async function renameTask(task, text) {
    const was = task.text;
    if (!text || text === was) { renderCraftTasks(); return; }
    task.text = text;
    renderCraftTasks();
    try {
      if (task.builtin) await hub.renameTask(task.id, text);
      else if (isTodoist(task.spaceId)) await todoist.renameTask(task.id, text);
      else await craft(task.spaceId, "/tasks", {
        method: "PUT",
        body: JSON.stringify({ tasksToUpdate: [{ id: task.id, markdown: (task.prefix || "") + text }] }),
      });
      toast("Renamed");
    } catch (err) {
      console.error("Renaming failed:", err);
      task.text = was;
      renderCraftTasks();
      toast(err instanceof TypeError ? "Couldn’t reach Craft, Todoist or lifeOS"
        : /scope/i.test(err.message) ? scopeHelp(task.spaceId)
        : `Couldn’t rename it: ${err.message}`, "err");
    }
  }

  // Tapping a task's text turns it into a box to rename it. Enter or tapping
  // away saves; Escape puts it back as it was. Only one is open at a time.
  let finishEdit = null;
  function editText(task, row) {
    finishEdit?.(true);
    const shown = row.querySelector(".t-text");
    if (!shown || row.querySelector(".t-edit")) return;
    const box = document.createElement("textarea");
    box.className = "t-edit";
    box.rows = 1;
    box.value = task.text;
    box.setAttribute("aria-label", "Task name");
    box.setAttribute("enterkeyhint", "done");
    const fit = () => { box.style.height = "auto"; box.style.height = box.scrollHeight + "px"; };
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      finishEdit = null;
      if (save) renameTask(task, box.value.replace(/\s+/g, " ").trim());
      else renderCraftTasks();
    };
    box.addEventListener("input", fit);
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    box.addEventListener("blur", () => finish(true));
    finishEdit = finish;
    shown.replaceWith(box);
    fit();
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }

  const scopeHelp = (spaceId) =>
    `This task is inside a document, and the ${spaceLabel(spaceId)} connection can only change tasks in the inbox and daily notes. In Craft, create an “All Documents” connection for that space and paste its URL in the settings.`;

  // The list is kept on this device, so tasks. opens with it straight away and
  // then brings it up to date (tagged with who it belongs to).
  const CACHE_KEY = "tasks.cache";
  let cacheOwner = null;
  function saveCache() {
    if (!cacheOwner) return;
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ uid: cacheOwner, at: Date.now(), tasks: craftTasks })); } catch { /* full or private */ }
  }

  function renderCraftTasks() {
    const box = $("craft-tasks");
    const title = $("craft-title");
    $("refresh").textContent = loadingTasks && craftTasks.length ? "Updating…" : "Refresh";
    saveCache();
    title.textContent = "";
    if (loadingTasks && !craftTasks.length) {
      box.innerHTML = `<p class="loading">Loading your tasks…</p>`;
      return;
    }
    if (!craftTasks.length) {
      box.innerHTML = `<p class="empty">Nothing to do. Type or speak a task above to add one.</p>`;
      return;
    }
    // Anything overdue belongs with today: it still needs doing today.
    const due = (t) => { const d = dayDiff(t.date); return d !== null && d <= 0; };
    // Every space can hold tasks now, so each gets a filter chip.
    const spaces = SPACES;
    const shown = craftTasks.filter(t => (spaces.length < 2 || !hiddenSpaces.has(t.spaceId)) && (!highOnly || t.priority === 3));
    if (spaces.length > 1) title.replaceChildren(filterRow(spaces));
    box.replaceChildren(
      fold("today", "today", shown.filter(due), false, moveAllButton),
      fold("upcoming", "upcoming", shown.filter(t => t.date && !due(t)), true),
      fold("nodate", "no date", shown.filter(t => !t.date)),
      doneFold(doneTasks.filter(t => spaces.length < 2 || !hiddenSpaces.has(t.spaceId))),
    );
  }

  // done.: lifeOS tasks ticked off in the past week, newest first, each with
  // Restore in case one was ticked by mistake. Closed until opened.
  function doneFold(list) {
    const wrap = document.createElement("section");
    const closed = openSections.done !== true;
    wrap.className = `fold done-fold${closed ? " closed" : ""}`;
    wrap.innerHTML = `<div class="fold-top"><button class="fold-head"><span class="fold-name">done<span class="dot">.</span></span>
        <span class="n">${list.length || ""}</span>
        <svg class="chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </button></div><div class="fold-body"></div>`;
    const body = wrap.querySelector(".fold-body");
    if (!list.length) body.innerHTML = `<p class="empty">Tasks kept in lifeOS show here for a week after you tick them off.</p>`;
    for (const task of list) {
      const row = document.createElement("div");
      row.className = "t-row done";
      const when = new Date(task.doneAt);
      const ago = dayDiff(isoDay(when));
      const day = ago === 0 ? "today" : ago === -1 ? "yesterday" : when.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
      row.innerHTML = `<span class="tick" aria-hidden="true"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>
        <div class="t-body"><div class="t-text"></div><div class="t-meta">
          <span class="t-space ${task.spaceId}"><span class="dot"></span>${esc(spaceLabel(task.spaceId))}</span>
          <span>ticked off ${esc(day)}, ${when.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>
        </div></div>
        <button type="button" class="link-btn restore">Restore</button>`;
      row.querySelector(".t-text").textContent = task.text || "(no text)";
      row.querySelector(".restore").onclick = () => restoreTask(task);
      body.append(row);
    }
    wrap.querySelector(".fold-head").onclick = () => {
      openSections.done = !wrap.classList.toggle("closed");
      try { localStorage.setItem("tasks.sections", JSON.stringify(openSections)); } catch { /* private mode */ }
    };
    return wrap;
  }

  async function restoreTask(task) {
    try {
      await hub.reopenTask(task.id);
      doneTasks = doneTasks.filter(t => t.id !== task.id);
      const { doneAt, ...open } = task;
      craftTasks = [...craftTasks.filter(t => t.id !== task.id), open];
      renderCraftTasks();
      toast(`${task.text} is back`);
    } catch (err) {
      console.error("Restoring a task failed:", err);
      toast(`Couldn’t restore it: ${err.message}`, "err");
    }
  }

  // One chip per list, each switched on or off. The last one left on can't be
  // switched off, so there is always something to show.
  function filterRow(spaces) {
    const row = document.createElement("div");
    row.className = "filters";
    for (const space of spaces) {
      const on = !hiddenSpaces.has(space.id);
      const chip = document.createElement("button");
      chip.className = `chip filter${on ? ` space-${space.id}` : ""}`;
      chip.setAttribute("aria-pressed", on);
      chip.textContent = space.label;
      chip.onclick = () => {
        if (on && spaces.every(s => s.id === space.id || hiddenSpaces.has(s.id))) return;
        if (on) hiddenSpaces.add(space.id); else hiddenSpaces.delete(space.id);
        try { localStorage.setItem("tasks.hidden", JSON.stringify([...hiddenSpaces])); } catch { /* private mode */ }
        renderCraftTasks();
      };
      row.append(chip);
    }
    // Red tasks only, across every list shown.
    const high = document.createElement("button");
    high.className = "chip filter high";
    high.setAttribute("aria-pressed", highOnly);
    high.innerHTML = `<span class="light"></span>`;
    high.setAttribute("aria-label", "High priority only");
    high.title = "High priority only";
    high.onclick = () => {
      highOnly = !highOnly;
      try { localStorage.setItem("tasks.highOnly", highOnly ? "1" : ""); } catch { /* private mode */ }
      renderCraftTasks();
    };
    row.append(high);
    return row;
  }

  const bySpaceOrder = (a, b) =>
    SPACES.findIndex(s => s.id === a.spaceId) - SPACES.findIndex(s => s.id === b.spaceId);
  const byDate = (a, b) => (a.date || "9999").localeCompare(b.date || "9999");

  // today. is one day's worth, so it reads by space: my space., work., joint.
  // upcoming. spans days, so the date leads and each day then reads in that
  // same space order. Undated tasks have their own no date. section below.
  const inOrder = (list, dateFirst) => [...list].sort((a, b) =>
    (dateFirst ? byDate(a, b) || bySpaceOrder(a, b) : bySpaceOrder(a, b) || byDate(a, b)) ||
    (b.priority || 0) - (a.priority || 0) || a.text.localeCompare(b.text));

  function fold(key, label, list, dateFirst = false, action = null) {
    const wrap = document.createElement("section");
    const closed = openSections[key] === false || (!list.length && openSections[key] !== true);
    wrap.className = `fold${closed ? " closed" : ""}`;
    wrap.innerHTML = `<div class="fold-top"><button class="fold-head"><span class="fold-name">${esc(label)}<span class="dot">.</span></span>
        <span class="n">${list.length}</span>
        <svg class="chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </button></div><div class="fold-body"></div>`;
    if (action && list.length) wrap.querySelector(".fold-top").append(action(list));
    const body = wrap.querySelector(".fold-body");
    if (!list.length) body.innerHTML = `<p class="empty">Nothing here.</p>`;
    else inOrder(list, dateFirst).forEach(task => body.append(taskRow(task)));
    wrap.querySelector(".fold-head").onclick = () => {
      openSections[key] = !wrap.classList.toggle("closed");
      try { localStorage.setItem("tasks.sections", JSON.stringify(openSections)); } catch { /* private mode */ }
    };
    return wrap;
  }

  const isoDay = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  // Moves everything in today. (overdue included) to tomorrow in one go. Craft
  // takes a whole space's worth in one request; Todoist takes them one at a
  // time, a repeating one keeping its repeat (see todoist.rescheduleTask).
  // Tasks this connection can't change are left alone.
  function moveAllButton(list) {
    const btn = document.createElement("button");
    btn.className = "move-all";
    btn.textContent = "→ tomorrow";
    btn.setAttribute("aria-label", "Move all of today’s and overdue tasks to tomorrow");
    btn.onclick = () => moveToTomorrow(list, btn);
    return btn;
  }

  async function moveToTomorrow(list, btn) {
    const movable = list.filter(t => !isLocked(t));
    const skipped = list.length - movable.length;
    if (!movable.length) { toast("None of these can be moved from here", "err"); return; }
    const tomorrow = new Date(startOfToday());
    tomorrow.setDate(tomorrow.getDate() + 1);
    const date = isoDay(tomorrow);
    btn.disabled = true;
    btn.textContent = "Moving…";
    const groups = new Map();
    for (const task of movable) {
      const key = task.builtin ? "lifeos" : task.spaceId;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(task);
    }
    let moved = 0;
    const errors = [];
    await Promise.all([...groups].map(async ([spaceId, tasks]) => {
      if (spaceId === "lifeos") {
        try {
          await hub.rescheduleTask(tasks.map(t => t.id), date);
          tasks.forEach(t => { t.date = date; });
          moved += tasks.length;
        } catch (err) {
          errors.push(err);
        }
        return;
      }
      if (isTodoist(spaceId)) {
        await Promise.all(tasks.map(task => todoist.rescheduleTask(task, date)
          .then(() => { task.date = date; moved++; })
          .catch(err => errors.push(err))));
        return;
      }
      try {
        await craft(spaceId, "/tasks", {
          method: "PUT",
          body: JSON.stringify({ tasksToUpdate: tasks.map(t => ({ id: t.id, taskInfo: { scheduleDate: date } })) }),
        });
        tasks.forEach(t => { t.date = date; });
        moved += tasks.length;
      } catch (err) {
        errors.push(err);
      }
    }));
    await Promise.all(movable.filter(t => t.date === date).map(t => followTask(t, date)));
    renderCraftTasks();
    if (errors.length) {
      console.error("Moving tasks to tomorrow failed:", errors);
      const err = errors[0];
      toast(`${moved ? `Moved ${moved}, but some` : "The tasks"} couldn’t be moved: ${
        err instanceof TypeError ? "couldn’t reach Craft, Todoist or lifeOS" : err.message}`, "err");
    } else {
      toast(`Moved ${moved} task${moved === 1 ? "" : "s"} to tomorrow${skipped ? ` · ${skipped} locked left as is` : ""}`);
    }
  }

  const isLocked = (task) =>
    !task.builtin && !isTodoist(task.spaceId) && task.where.rank === 2 && canEditDocs[task.spaceId] === false;

  function taskRow(task) {
    const row = document.createElement("div");
    row.className = `t-row${task.priority ? ` p${task.priority}` : ""}`;
    row.innerHTML = `<button class="tick" aria-label="Tick off"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></button>
      <div class="t-body"><div class="t-text"></div><div class="t-meta">
        ${task.builtin ? `<button type="button" class="t-space ${task.spaceId}" aria-label="In ${esc(spaceLabel(task.spaceId))}, tap to move"><span class="dot"></span>${esc(spaceLabel(task.spaceId))}</button>`
          : `<span class="t-space ${task.spaceId}"><span class="dot"></span>${esc(spaceLabel(task.spaceId))}</span>`}
        <button type="button" class="t-prio${task.priority ? ` p${task.priority}` : ""}" aria-label="Priority: ${PRIORITY[task.priority || 0]}, tap to change">${LIGHT}${task.priority ? PRIORITY[task.priority] : ""}</button>
        <button type="button" class="t-when${isLate(task) ? " late" : ""}${task.date ? "" : " none"}" aria-label="Change the date or time">
          <span class="when-text">${esc(whenText(task))}</span>
        </button>
        ${task.builtin ? (task.shared ? `<span class="t-doc">shared</span>` : "")
          : isTodoist(task.spaceId) ? `<button class="t-doc" aria-label="In ${esc(task.where.label)}, tap to move"><span>${esc(task.where.label)}</span></button>`
          : `<button class="t-doc" aria-label="In ${esc(task.where.label)}, tap to move"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span>${esc(task.where.label)}</span></button>`}
        ${task.recurring ? `<span class="t-rep" title="${esc(task.repeatText || "Repeats")}" aria-label="${esc(task.repeatText || "Repeats")}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg></span>` : ""}
      </div></div>`;
    row.querySelector(".t-text").textContent = task.text || "(no text)";
    row.querySelector(".t-when").onclick = () => openWhen(task, row);
    row.querySelector(".t-prio").onclick = () => openPriority(task);
    row.querySelector("button.t-space")?.addEventListener("click", () => openSpaceMove(task));
    const locked = isLocked(task);
    row.classList.toggle("locked", locked);
    row.querySelector(".tick").onclick = () => locked ? toast(scopeHelp(task.spaceId), "err") : completeTask(task, row);
    row.querySelector(".t-text").onclick = () => locked ? toast(scopeHelp(task.spaceId), "err") : editText(task, row);
    swipeable(row, task);
    const doc = row.querySelector("button.t-doc");
    if (doc) doc.onclick = () => !isTodoist(task.spaceId) && canEditDocs[task.spaceId] === false ? toast(scopeHelp(task.spaceId), "err") : openMove(task);
    return row;
  }

  // ─── Moving a task to another document or project ────────────────────
  // Tapping a task's document opens a searchable list of that space's
  // documents (and the inbox); a Todoist task's project opens its projects. Craft lists every document at once, trash,
  // templates and daily notes included, so those three are fetched too and
  // left out. The list is kept for the visit; Refresh fetches it again.
  const docLists = {};   // space ID → promise of [{ id, title }]
  function loadDocs(spaceId) {
    if (isTodoist(spaceId)) return Promise.resolve(projects.map(p => ({ id: String(p.id), title: p.name })));
    if (!docLists[spaceId]) {
      const list = (q = "") => craft(spaceId, `/documents${q}`).then(r => r.items || []);
      docLists[spaceId] = Promise.all([list(), list("?location=trash"), list("?location=templates"), list("?location=daily_notes")])
        .then(([all, ...skip]) => {
          const out = new Set(skip.flat().map(d => d.id));
          return all.filter(d => !out.has(d.id))
            .map(d => ({ id: d.id, title: d.title?.trim() || "Untitled" }))
            .sort((a, b) => a.title.localeCompare(b.title));
        });
      docLists[spaceId].catch(() => { delete docLists[spaceId]; });
    }
    return docLists[spaceId];
  }

  const moveDialog = $("move");
  const moveSearch = $("move-search");
  const moveList = $("move-list");
  let moving = null;   // the task the dialog is open for

  async function openMove(task) {
    finishEdit?.(true);
    moving = task;
    $("move-task").textContent = task.text;
    moveSearch.value = "";
    moveSearch.placeholder = isTodoist(task.spaceId) ? "Search projects" : "Search documents";
    moveList.innerHTML = `<p class="note">Loading documents…</p>`;
    moveDialog.showModal();
    try {
      const docs = await loadDocs(task.spaceId);
      if (moving === task) showDocs(docs);
    } catch (err) {
      console.error("Loading documents failed:", err);
      if (moving !== task) return;
      moveList.innerHTML = `<p class="note">${esc(err.status === 404 ? scopeHelp(task.spaceId)
        : err instanceof TypeError ? "Couldn’t reach Craft." : `Couldn’t load the documents: ${err.message}`)}</p>`;
    }
  }

  // With nothing typed, the documents already holding tasks in this space come
  // first, as the likeliest places to move one to; typing searches every title.
  function showDocs(docs) {
    const task = moving;
    if (!task) return;
    const q = moveSearch.value.trim().toLowerCase();
    const placeId = (t) => t.where.docId || t.where.projectId;
    const inUse = new Set(craftTasks.filter(t => t.spaceId === task.spaceId).map(placeId).filter(Boolean));
    const matches = q
      ? docs.filter(d => d.title.toLowerCase().includes(q))
      : [...docs.filter(d => inUse.has(d.id)), ...docs.filter(d => !inUse.has(d.id))];
    const here = (d) => d.id === placeId(task);
    const opts = [];
    if (!isTodoist(task.spaceId) && (!q || "inbox".includes(q))) opts.push({ dest: { type: "inbox" }, label: "Inbox", here: task.where.rank === 0 });
    for (const d of matches) opts.push({ dest: { type: "document", id: d.id, title: d.title }, label: d.title, here: here(d) });
    if (!opts.length) { moveList.innerHTML = `<p class="note">No ${isTodoist(task.spaceId) ? "project" : "document"} called that.</p>`; return; }
    moveList.replaceChildren(...opts.map(o => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `doc-opt${o.here ? " here" : ""}`;
      btn.innerHTML = `<span class="t"></span>${o.here ? `<span class="tag">here now</span>` : ""}`;
      btn.firstChild.textContent = o.label;
      btn.onclick = () => {
        moveDialog.close();
        if (!o.here) moveTask(task, o.dest);
      };
      return btn;
    }));
  }

  moveSearch.addEventListener("input", () => { if (moving) loadDocs(moving.spaceId).then(showDocs, () => {}); });
  // Enter would submit the dialog's form and close it, so it picks the top match.
  moveSearch.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    moveList.querySelector(".doc-opt:not(.here)")?.click();
  });
  moveDialog.addEventListener("close", () => { moving = null; });

  async function moveTask(task, dest) {
    const was = task.where;
    task.where = isTodoist(task.spaceId) ? { key: `p:${dest.id}`, label: dest.title, rank: 2, projectId: dest.id }
      : placeOf(dest.type === "inbox" ? { type: "inbox" } : { type: "document", documentId: dest.id, title: dest.title });
    renderCraftTasks();
    try {
      if (isTodoist(task.spaceId)) await todoist.moveTask(task.id, dest.id);
      else await craft(task.spaceId, "/tasks", {
        method: "PUT",
        body: JSON.stringify({ tasksToUpdate: [{ id: task.id, location: dest.type === "inbox" ? { type: "inbox" } : { type: "document", documentId: dest.id } }] }),
      });
      toast(`${task.text} → ${task.where.label}`);
    } catch (err) {
      console.error("Moving the task failed:", err);
      task.where = was;
      renderCraftTasks();
      toast(err instanceof TypeError ? "Couldn’t reach Craft, Todoist or lifeOS"
        : /scope/i.test(err.message) ? scopeHelp(task.spaceId)
        : `Couldn’t move it: ${err.message}`, "err");
    }
  }

  function refreshAll() {
    for (const id in docLists) delete docLists[id];
    skipFresh = true;
    return loadCraftTasks();
  }
  $("refresh").addEventListener("click", refreshAll);
  // Pull down from the top of the page to refresh, unless a box is open.
  pullToRefresh({
    refresh: refreshAll,
    scroller: () => host,   // the app's box scrolls, in lifeOS and on its own page
    enabled: () => !document.querySelector("dialog[open]") && !document.querySelector(".t-edit") && !loadingTasks,
  });

  // ─── Swiping a task ──────────────────────────────────────────────────
  // Right past the mark ticks it off (with Undo); left asks which day to move
  // it to (tomorrow first, the week after, or any date), its time block too. A mostly-vertical drag is left to scroll the page, and
  // a touch starting at the very left edge is left to lifeOS's own handle.
  const SWIPE = 90;
  function swipeable(row, task) {
    let x0 = null, y0 = 0, dx = 0, sideways = false, pointer = null, swipedAt = 0;
    const clear = () => {
      row.classList.remove("swiping", "armed");
      row.style.setProperty("--dx", "0px");
      setTimeout(() => row.classList.remove("swipe-r", "swipe-l"), 200);
    };
    row.addEventListener("pointerdown", (e) => {
      if ((e.pointerType === "mouse" && e.button !== 0) || e.target.closest("textarea, input") || e.clientX < 24) return;
      x0 = e.clientX; y0 = e.clientY; dx = 0; sideways = false; pointer = e.pointerId;
    });
    row.addEventListener("pointermove", (e) => {
      if (x0 === null || e.pointerId !== pointer) return;
      const mx = e.clientX - x0, my = e.clientY - y0;
      if (!sideways) {
        if (Math.abs(mx) > 10 && Math.abs(mx) > Math.abs(my) * 1.5) {
          sideways = true;
          row.setPointerCapture?.(pointer);
          row.classList.add("swiping");
        } else if (Math.abs(my) > 10) { x0 = null; return; } else return;
      }
      dx = mx;
      row.style.setProperty("--dx", `${dx}px`);
      row.classList.toggle("swipe-r", dx > 0);
      row.classList.toggle("swipe-l", dx < 0);
      row.classList.toggle("armed", Math.abs(dx) > SWIPE);
    });
    row.addEventListener("pointerup", () => {
      if (x0 === null) return;
      x0 = null;
      if (!sideways) return;
      swipedAt = Date.now();
      clear();
      if (Math.abs(dx) <= SWIPE) return;
      if (isLocked(task)) { toast(scopeHelp(task.spaceId), "err"); return; }
      if (dx > 0) completeTask(task, row);
      else openMoveDay(task, row);
    });
    row.addEventListener("pointercancel", () => { x0 = null; if (sideways) clear(); });
    // The tap that ends a swipe isn't also a tap on the task's text or date.
    row.addEventListener("click", (e) => { if (Date.now() - swipedAt < 400) { e.stopPropagation(); e.preventDefault(); } }, true);
  }

  const dayDialog = $("move-day");
  let dayFor = null;
  function openMoveDay(task, row) {
    finishEdit?.(true);
    dayFor = { task, row };
    $("move-day-task").textContent = task.text;
    const opts = [];
    for (let n = 1; n <= 7; n++) {
      const d = new Date(startOfToday());
      d.setDate(d.getDate() + n);
      const weekday = d.toLocaleDateString("en-GB", { weekday: "short" });
      const label = n === 1 ? `Tomorrow <small>${weekday} ${d.getDate()}</small>` : `${weekday} <small>${d.getDate()} ${d.toLocaleDateString("en-GB", { month: "short" })}</small>`;
      opts.push(`<button class="prio-opt${task.date === isoDay(d) ? " on" : ""}" value="${isoDay(d)}">${label}</button>`);
    }
    $("move-day-opts").innerHTML = opts.join("");
    const pick = $("move-day-date");
    pick.value = task.date || "";
    pick.min = isoDay(startOfToday());
    pick.onchange = () => { if (pick.value) dayDialog.close(pick.value); };
    dayDialog.showModal();
  }
  dayDialog.addEventListener("close", async () => {
    const { task, row } = dayFor || {}, date = dayDialog.returnValue;
    dayFor = null;
    dayDialog.returnValue = "";
    if (!task || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    if (task.date === date) { toast(`${task.text} is already ${dateText(date).toLowerCase()}`); return; }
    await reschedule(task, date, row);
  });

  // ─── Moving a task kept in lifeOS to another space ───────────────────
  const spaceDialog = $("space-move");
  let spaceFor = null;
  function openSpaceMove(task) {
    finishEdit?.(true);
    spaceFor = task;
    $("space-move-task").textContent = task.text;
    spaceDialog.querySelectorAll(".prio-opt").forEach(b => b.classList.toggle("on", b.value === task.spaceId));
    spaceDialog.showModal();
  }
  spaceDialog.addEventListener("close", async () => {
    const task = spaceFor, to = spaceDialog.returnValue;
    spaceFor = null;
    spaceDialog.returnValue = "";
    if (!task || !SPACES.some(s => s.id === to) || to === task.spaceId) return;
    const was = { spaceId: task.spaceId, shared: task.shared, where: task.where };
    task.spaceId = to;
    renderCraftTasks();
    try {
      ({ shared: task.shared } = await hub.moveSpace(task, to));
      task.where = { ...task.where, label: task.shared ? "shared" : "lifeOS" };
      renderCraftTasks();
      toast(`${task.text} → ${spaceLabel(to)}${to === "todoist" && !task.shared ? " (join a household in food. to share it)" : ""}`);
    } catch (err) {
      console.error("Moving the task failed:", err);
      Object.assign(task, was);
      renderCraftTasks();
      toast(`Couldn’t move it: ${err.message}`, "err");
    }
  });

  // ─── Priority ────────────────────────────────────────────────────────
  // Tasks kept in lifeOS and Todoist tasks carry their own priority (Todoist's
  // p1–p3 are red, amber, green); a Craft task's is kept in lifeOS.
  const prioDialog = $("prio");
  let prioFor = null;

  function openPriority(task) {
    finishEdit?.(true);
    prioFor = task;
    $("prio-task").textContent = task.text;
    prioDialog.querySelectorAll(".prio-opt").forEach(b => b.classList.toggle("on", Number(b.value) === (task.priority || 0)));
    prioDialog.showModal();
  }

  prioDialog.addEventListener("close", () => {
    const task = prioFor;
    prioFor = null;
    // Escape and Cancel leave no number behind, so nothing changes.
    const raw = prioDialog.returnValue;
    prioDialog.returnValue = "";
    const p = /^[0-3]$/.test(raw) ? Number(raw) : NaN;
    if (task && Number.isInteger(p) && p >= 0 && p <= 3 && p !== (task.priority || 0)) setPriority(task, p);
  });

  async function setPriority(task, p) {
    const was = task.priority || 0;
    task.priority = p;
    renderCraftTasks();
    try {
      if (task.builtin) await hub.setPriority(task.id, p);
      else if (isTodoist(task.spaceId)) await todoist.setPriority(task.id, p);
      else await hub.setCraftPriority(task.spaceId, task.id, p);
      toast(`${task.text} → ${p ? `${PRIORITY[p].toLowerCase()} priority` : "no priority"}`);
    } catch (err) {
      console.error("Changing the priority failed:", err);
      task.priority = was;
      renderCraftTasks();
      toast(err instanceof TypeError ? "Couldn’t reach Todoist or lifeOS" : `Couldn’t change the priority: ${err.message}`, "err");
    }
  }

  // Priorities said for new Craft tasks, once they're in the list. A task
  // without an ID from Craft is found by its text, as time blocks are.
  async function lightCraftTasks(list) {
    for (const item of list) {
      const task = (item.id && craftTasks.find(t => t.id === item.id && t.spaceId === item.spaceId))
        || craftTasks.find(t => t.spaceId === item.spaceId && t.text === item.text && !t.priority);
      if (!task) continue;
      try {
        await hub.setCraftPriority(task.spaceId, task.id, item.priority);
        task.priority = item.priority;
      } catch (err) {
        console.error("Saving a Craft task's priority failed:", err);
        toast(`Couldn’t save the priority for ${item.text}`, "err");
      }
    }
    renderCraftTasks();
  }

  // ─── Changing a task's date and time ─────────────────────────────────
  // Tapping a task's date opens this. The date is the task's own, in Craft or
  // Todoist; the time is its block on the calendar (see Time blocks), so
  // setting one needs Google Calendar connected, and a time with no date
  // means today.
  const whenDialog = $("when");
  const whenDate = $("when-date");
  const whenTime = $("when-time");
  let whenFor = null;   // { task, row } the dialog is open for

  function openWhen(task, row) {
    finishEdit?.(true);
    whenFor = { task, row };
    $("when-task").textContent = task.text;
    whenDate.value = task.date || "";
    whenTime.value = timeOf(task);
    $("when-clear").hidden = !timeOf(task);
    // Repeats: tasks kept in lifeOS and Todoist ones. Craft's can't be set from here.
    const canRepeat = task.builtin || isTodoist(task.spaceId);
    $("when-repeat-box").hidden = !canRepeat;
    repeatInput.value = task.builtin ? (task.repeat?.text || "") : (task.repeatText || "");
    repeatInput.dataset.was = repeatInput.value;
    previewRepeat();
    $("when-note").textContent = gcal.isConnected() || gcal.wasConnected() ? ""
      : "A time is blocked out on Google Calendar. Connect it in settings first.";
    whenDialog.showModal();
  }

  $("when-clear").addEventListener("click", () => { whenTime.value = ""; whenDialog.close("save"); });

  const repeatInput = $("when-repeat");
  // What the typed repeat means, shown as it's typed. Blank means no repeat.
  function previewRepeat() {
    const box = $("when-repeat-preview");
    const words = repeatInput.value.trim();
    box.className = "repeat-preview";
    if (!words) { box.textContent = repeatInput.dataset.was ? "Won’t repeat any more" : "Doesn’t repeat"; return null; }
    const { repeat } = rep.parseRepeat(words);
    if (!repeat) { box.className = "repeat-preview err"; box.textContent = "Try “every Monday”, “weekdays”, “every 2 weeks on Tue and Thu” or “last Friday of the month”."; return null; }
    const { rule, date } = rep.withAnchor(repeat, whenDate.value || null);
    box.textContent = `${rep.describe(rule)} · next ${dateText(date)}`;
    return repeat;
  }
  repeatInput.addEventListener("input", previewRepeat);
  repeatInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); whenDialog.close("save"); } });
  // Enter would submit through the form's first button, Cancel, so it saves.
  for (const f of [whenDate, whenTime]) f.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    whenDialog.close("save");
  });
  whenDialog.addEventListener("close", () => {
    const open = whenFor;
    whenFor = null;
    if (open && whenDialog.returnValue === "save") {
      const words = repeatInput.value.trim();
      const changed = words !== (repeatInput.dataset.was || "") && !$("when-repeat-box").hidden;
      setWhen(open.task, open.row, whenDate.value, whenTime.value).then(() => changed && setRepeat(open.task, words));
    }
    whenDialog.returnValue = "";
  });

  // A repeat typed in the When box. Tasks kept in lifeOS keep the rule (and
  // move to its first date); Todoist reads the words itself.
  async function setRepeat(task, words) {
    const said = words ? rep.parseRepeat(words).repeat : null;
    if (words && !said) { toast("That repeat wasn’t one I know, so nothing changed.", "err"); return; }
    try {
      if (task.builtin) {
        const { date, repeat } = await hub.setRepeat(task, said);
        if (date && date !== task.date) await followTask(task, date);
        Object.assign(task, { date, repeat, recurring: Boolean(repeat), repeatText: rep.describe(repeat) });
      } else {
        await todoist.setRepeat(task, said?.text || "");
        Object.assign(task, { recurring: Boolean(said), repeatText: said?.text || "" });
      }
      renderCraftTasks();
      toast(said ? `${task.text} → ${task.builtin ? task.repeatText : said.text}` : `${task.text} won’t repeat`);
    } catch (err) {
      console.error("Changing the repeat failed:", err);
      toast(`Couldn’t change the repeat: ${err.message}`, "err");
    }
  }

  async function setWhen(task, row, date, time) {
    if (time && !date) date = isoDay(new Date());
    if (date && date !== task.date && !(await reschedule(task, date, row))) return;
    if (!task.date || time === timeOf(task)) return;
    const b = blocks.get(task.id);
    if (!time) {
      try {
        await gcal.deleteBlock(b);
        blocks.delete(task.id);
        toast(`${task.text} → ${whenText(task)}`);
      } catch (err) {
        console.error("Removing the time block failed:", err);
        toast(`Couldn’t remove the time: ${err.message}`, "err");
      }
    } else if (b) {
      try {
        blocks.set(task.id, await gcal.moveBlock(b, task.date, time));
        toast(`${task.text} → ${whenText(task)}`);
      } catch (err) {
        console.error("Changing the time failed:", err);
        toast(`Couldn’t change the time: ${err.message}`, "err");
      }
    } else {
      // placeBlocks waits for a sign-in when there isn't one, and toasts itself.
      return placeBlocks([{ id: String(task.id), text: task.text, spaceId: task.spaceId, date: task.date, time, minutes: gcal.DEFAULT_MINUTES }]);
    }
    renderCraftTasks();
  }

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

  // Google Calendar, for the times tasks are blocked out at. The client is the
  // one calendar. uses; this page's address has to be one of its authorised
  // redirect URIs for signing in here.
  function googleBox() {
    const box = document.createElement("div");
    box.className = "cal-box";
    const connected = gcal.isConnected();
    box.innerHTML = `
      <h3><span class="dot" style="background:var(--muted)"></span>Google Calendar</h3>
      <label class="f">OAuth client ID</label>
      <input class="field" data-k="client" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="….apps.googleusercontent.com">
      <p class="note">Shows the time each task is blocked out in calendar., and blocks out a time you say (“call Sam at 3pm”). It’s the same client as calendar.; add <b>${esc(location.origin + location.pathname)}</b> to its authorised redirect URIs.</p>
      <div class="row"><button type="button" class="btn">${connected ? "Disconnect" : "Connect"}</button><span class="test-result"></span></div>`;
    const id = box.querySelector("[data-k=client]");
    id.value = clientId();
    const result = box.querySelector(".test-result");
    result.className = `test-result${connected ? " ok" : ""}`;
    result.textContent = connected ? `Connected${gcal.email() ? ` as ${gcal.email()}` : ""}` : gcal.wasConnected() ? "Signed out" : "Not connected";
    id.addEventListener("change", () => { settings.google = { clientId: id.value.trim() }; saveSettings(settings); });
    box.querySelector(".btn").addEventListener("click", () => {
      if (connected) {
        gcal.disconnect();
        blocks = new Map();
        renderCraftTasks();
        $("google-fields").replaceChildren(googleBox());
        return;
      }
      settings.google = { clientId: id.value.trim() };
      saveSettings(settings);
      if (clientId() && !clientId().endsWith(".apps.googleusercontent.com")) {
        result.className = "test-result err";
        result.textContent = "Paste the client ID from calendar.’s settings";
        return;
      }
      gcal.connect(clientId());
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
    $("google-fields").replaceChildren(googleBox());
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

  // calendar. and tasks. link to each other. Inside the lifeOS picker the
  // picker switches tabs; opened on its own, the link is simply followed.
  document.querySelectorAll("a[data-hub]").forEach(a => a.addEventListener("click", (e) => {
    try {
      if (window.top.lifeosOpen?.(a.dataset.hub)) e.preventDefault();
    } catch { /* another site's frame: follow the link */ }
  }));

  // Back from Google, or due a quiet trip there for a fresh token.
  const preloaded = ctx.url.searchParams.has("preload");
  if (preloaded && ctx.standalone) history.replaceState(history.state, "", location.pathname + location.hash);
  // Inside lifeOS, Google's reply comes in the address lifeOS opened this with.
  const back = gcal.takeRedirect(ctx.standalone ? location.hash : ctx.url.hash, { tidy: ctx.standalone });
  let onShown = null;   // lifeOS saying tasks. is now on screen
  if (back?.error && gcal.pending().length) {
    toast("Sign in to Google Calendar in settings to block out the times you said.", "err");
  } else if (!back && clientId() && gcal.wasConnected() && !gcal.isConnected() && !gcal.silentTried()) {
    // Loaded ahead of time behind the lifeOS picker (?preload), the trip to
    // Google, which takes the whole page with it, waits until tasks. is opened.
    if (preloaded) {
      // Told by the picker, or (if that came before this listened) the first touch.
      // (A touch on tasks. itself, not anywhere in lifeOS.)
      const renew = () => {
        onShown = null;
        root.removeEventListener("pointerdown", renew);
        if (!gcal.isConnected() && !gcal.silentTried()) gcal.connect(clientId(), { silent: true });
      };
      onShown = renew;
      root.addEventListener("pointerdown", renew);
    } else {
      gcal.connect(clientId(), { silent: true });
    }
  }

  render();
  // The saved list straight away, then the real one. Whose list it is gets
  // checked as soon as the sign-in answers (which can take a moment after an
  // hour away), and a list that isn't this person's is dropped.
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); } catch { /* start empty */ }
  if (saved?.uid && Array.isArray(saved.tasks)) {
    craftTasks = saved.tasks.filter(t => !String(t.id).startsWith("tmp-"));
    loadingTasks = true;
    renderCraftTasks();
  }
  hub.userId().catch(() => null).then((uid) => {
    cacheOwner = uid;
    if (saved?.uid && saved.uid !== uid) { craftTasks = []; renderCraftTasks(); }
    return loadCraftTasks();
  }).then(placePending);

  return { shown: () => onShown?.(), unmount: () => document.off() };
}
