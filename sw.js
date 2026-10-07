// tasks. service worker, registered by index.html.
const APP = "tasks";
const CACHE = `${APP}-1`;

// ─── Opening fast, and with no signal ───────────────────────────────
// Pages come from the network when it answers within 2.5 seconds (so updates
// arrive), otherwise from the copy saved here. Scripts, styles, fonts and
// icons come from the saved copy at once and are refreshed behind it; their
// ?v= numbers make a new release a new file. Requests to Supabase, Google,
// Craft and Todoist aren't touched. Caches are named per app, as every app
// on this site shares one cache store.
const CDN = ["https://cdn.jsdelivr.net", "https://fonts.googleapis.com", "https://fonts.gstatic.com"];
const KEEP = 250;   // files kept per app; the oldest go first

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith(`${APP}-`) && k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

async function save(req, res) {
  if (!res || !(res.ok || res.type === "opaque")) return;
  const c = await caches.open(CACHE);
  await c.put(req, res);
  const keys = await c.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP))) await c.delete(k);
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin && !CDN.includes(url.origin)) return;

  if (req.mode === "navigate") {
    e.respondWith((async () => {
      // Saved without the #hash or ?query, so any address of the page finds it.
      const key = url.origin + url.pathname;
      const network = fetch(req).then((res) => { if (res.ok) save(key, res.clone()); return res; });
      try {
        const res = await Promise.race([network, new Promise((r) => setTimeout(r, 2500))]);
        if (res) return res;
      } catch { /* offline */ }
      return (await caches.match(key)) || network;
    })());
    return;
  }

  e.respondWith((async () => {
    const cached = await caches.match(req);
    const fresh = fetch(req).then((res) => { save(req, res.clone()); return res; });
    if (cached) { e.waitUntil(fresh.catch(() => {})); return cached; }
    return fresh;
  })());
});
