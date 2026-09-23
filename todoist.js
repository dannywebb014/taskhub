// ─── Todoist ─────────────────────────────────────────────────────────
//
// The shared lists with people who don't use Craft. Todoist's v1 API
// allows browser requests, so this talks to it directly with a personal
// API token, the same way the Craft connections work.
//
// Active tasks are fetched whole and sorted here rather than asking the
// API to filter, which keeps this working whatever its filter syntax does.

const API = "https://api.todoist.com/api/v1";
export const DEFAULT_PROJECT = "Joint Reminders";

let token = "";
export const setToken = (value) => { token = String(value || "").trim(); };
export const hasToken = () => Boolean(token);

async function call(path, options = {}) {
  const resp = await fetch(API + path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...options.headers },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    const err = new Error(resp.status === 401 || resp.status === 403
      ? "Todoist didn’t accept that API token."
      : `${resp.status} ${body.slice(0, 120)}`);
    err.status = resp.status;
    throw err;
  }
  return resp.status === 204 ? null : resp.json();
}

// v1 pages its lists; older shapes return a plain array, so handle both.
async function all(path) {
  const out = [];
  let cursor = null;
  do {
    const query = `limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const page = await call(`${path}${path.includes("?") ? "&" : "?"}${query}`);
    out.push(...(Array.isArray(page) ? page : page.results || []));
    cursor = Array.isArray(page) ? null : page.next_cursor || null;
  } while (cursor && out.length < 1000);
  return out;
}

export const loadProjects = () => all("/projects");

export async function loadTasks(projects) {
  const names = new Map(projects.map(p => [String(p.id), p.name]));
  const tasks = await all("/tasks");
  return tasks
    .filter(t => !(t.checked ?? t.is_completed))
    .map(t => ({
      id: String(t.id),
      text: t.content || "",
      // A due date can carry a time; only the day matters here.
      date: (t.due?.date || "").slice(0, 10) || null,
      spaceId: "todoist",
      where: { key: `p:${t.project_id}`, label: names.get(String(t.project_id)) || "Todoist", rank: 2 },
    }));
}

export const closeTask = (id) => call(`/tasks/${id}/close`, { method: "POST" });

export const addTask = ({ text, date, projectId }) =>
  call("/tasks", {
    method: "POST",
    body: JSON.stringify({ content: text, ...(date ? { due_date: date } : {}), ...(projectId ? { project_id: projectId } : {}) }),
  });

// "joint, house fix the gate" → the House project, task "Fix the gate".
// Without a project name it falls back to the shared list.
export function pickProject(text, projects) {
  const cleaned = String(text || "").trim();
  const match = projects
    .filter(p => !p.inbox_project && !p.inboxProject)
    .map(p => ({ project: p, re: new RegExp(`^${p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[\\s,:;.\\-–—]*`, "i") }))
    .map(({ project, re }) => ({ project, hit: cleaned.match(re) }))
    .filter(x => x.hit)
    .sort((a, b) => b.hit[0].length - a.hit[0].length)[0];
  const rest = match ? cleaned.slice(match.hit[0].length).trim() : cleaned;
  const project = match?.project || projects.find(p => p.name === DEFAULT_PROJECT) || null;
  const tidied = rest ? rest[0].toUpperCase() + rest.slice(1) : cleaned;
  return { project, text: match ? tidied : cleaned };
}
