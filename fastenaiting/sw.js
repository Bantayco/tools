// fastenAIting service worker.
//
// Strategy:
//   • App shell (index, css, js, icons, manifest, shared tokens) is cached on
//     install and served cache-first, revalidated in the background — the tool
//     opens instantly and continues to work offline.
//   • /api/fastenaiting/identify is network-only (needs Anthropic; no useful
//     offline behavior).
//   • Everything else falls back to network, then cache, then a plain 503.
//
// Version tag bumps invalidate the shell cache on the next visit.

const VERSION = "fastenaiting-v1";
const SHELL_CACHE = `${VERSION}-shell`;

const SHELL = [
  "/fastenaiting/",
  "/fastenaiting/index.html",
  "/fastenaiting/app.js",
  "/fastenaiting/styles.css",
  "/fastenaiting/fasteners.js",
  "/fastenaiting/affiliate.js",
  "/fastenaiting/manifest.webmanifest",
  "/fastenaiting/icon.svg",
  "/fastenaiting/icon-192.png",
  "/fastenaiting/icon-512.png",
  "/fastenaiting/apple-touch-icon.png",
  "/fastenaiting/favicon-32.png",
  "/_shared/tokens.css",
  "/_shared/tokens-extended.css",
  "/_shared/base.css",
  "/_shared/dark.css",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Fetch each with { cache: "reload" } so we never seed the SW cache with
      // a stale HTTP-cached copy from before this deploy.
      await Promise.all(
        SHELL.map((url) =>
          fetch(url, { cache: "reload" })
            .then((res) => (res.ok ? cache.put(url, res.clone()) : null))
            .catch(() => null)
        )
      );
      self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith("fastenaiting-") && k !== SHELL_CACHE).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Only handle same-origin.
  if (url.origin !== self.location.origin) return;

  // Never cache the AI identify call.
  if (url.pathname.startsWith("/api/fastenaiting/")) return;

  // Only manage requests inside the tool's scope + shared assets.
  const inScope =
    url.pathname.startsWith("/fastenaiting/") ||
    url.pathname.startsWith("/_shared/");
  if (!inScope) return;

  event.respondWith(cacheFirst(req));
});

async function cacheFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(req, { ignoreSearch: false })
              || await cache.match(new Request(req.url.split("?")[0]));
  const fetchPromise = fetch(req)
    .then((res) => {
      if (res && res.ok && res.type === "basic") cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  if (cached) {
    // Fire-and-forget refresh; return the cached copy for speed.
    fetchPromise.catch(() => {});
    return cached;
  }
  const network = await fetchPromise;
  if (network) return network;
  return new Response("Offline and not cached.", { status: 503, headers: { "content-type": "text/plain" } });
}
