// apps/docs/public/sw.js
//
// Minimal app-shell cache for the installed docs PWA. No offline fallback:
// stale offline docs could show outdated instructions, so the only job here
// is "repeat loads of static assets feel instant," not "work with no
// network." Never intercepts /api/* (the Orama search route) or non-GET
// requests.
const CACHE_NAME = "oxagen-docs-shell-v2";
const SHELL_ASSETS = [
  "/manifest.webmanifest",
  "/favicon/favicon.svg",
  "/favicon/favicon-32.png",
  "/favicon/favicon-16.png",
  "/pwa/apple-touch-icon.png",
  "/pwa/icon-192.png",
  "/pwa/icon-512.png",
  "/pwa/maskable-192.png",
  "/pwa/maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      ),
  );
  self.clients.claim();
});

// Never intercept anything under /api/* (the search route) or non-GET
// requests — those must always hit the network live.
function isCacheable(request) {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) return false;
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/pwa/") ||
    url.pathname.startsWith("/favicon/") ||
    url.pathname.startsWith("/social/") ||
    url.pathname === "/manifest.webmanifest"
  );
}

self.addEventListener("fetch", (event) => {
  if (!isCacheable(event.request)) return;

  // Stale-while-revalidate: serve from cache immediately, refresh in the
  // background so the next load picks up new deployments.
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request);
      const network = fetch(event.request)
        .then((response) => {
          if (response.ok) cache.put(event.request, response.clone());
          return response;
        })
        .catch(() => cached);
      return cached ?? network;
    }),
  );
});
