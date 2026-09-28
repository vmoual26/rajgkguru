// Service worker: makes the site usable on a weak or absent connection (F32 offline mode, F53 low connectivity).
//  - App shell + shared scripts/styles + exam pages + question data are cached as they are used (stale-while-revalidate),
//    so a visited exam opens and its free tests run offline; an unfinished test already lives in localStorage.
//  - Cloud/API calls (Firebase, Razorpay, Cloud Functions, fonts) are never intercepted.
//  - Paid pools are never cached here (they are fetched with a Bearer token by the page, not through this cache).
const CACHE = "rgk-v3";
const NEVER = /googleapis|gstatic|firebase|razorpay|cloudfunctions|run\.app|get_paid_pool|identitytoolkit/;

self.addEventListener("install", (e) => { self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || NEVER.test(req.url)) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    const net = fetch(req).then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
    if (hit) { net.catch(() => {}); return hit; }                 // stale-while-revalidate
    const res = await net;
    if (res) return res;
    if (req.mode === "navigate") { const home = await cache.match("/"); if (home) return home; }
    return new Response("Offline", { status: 503, statusText: "Offline" });
  })());
});
