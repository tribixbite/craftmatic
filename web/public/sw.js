/**
 * Craftmatic Service Worker — minimal cache-first strategy.
 * Caches the app shell for offline capability; falls back to network for
 * external/API requests.
 */

const CACHE_NAME = 'craftmatic-v1';

/** App-shell resources to pre-cache on install */
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './favicon.svg',
];

// ─── Install: pre-cache the shell ──────────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  // Activate immediately without waiting for old tabs to close
  self.skipWaiting();
});

// ─── Activate: clean up old caches ─────────────────────────────────────────

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  // Take control of all open tabs immediately
  self.clients.claim();
});

// ─── Fetch: network-first for same-origin, network-first for external ───────
//
// Using network-first everywhere prevents stale ES modules from being served
// when the dev server or a new deploy serves updated code. The cache acts as
// a fallback for offline use only.

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests
  if (request.method !== 'GET') return;

  // Network-first: try the network, fall back to cache for offline
  event.respondWith(
    fetch(request)
      .then((response) => {
        // Cache a copy of successful responses for offline fallback
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});
