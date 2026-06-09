const CACHE_NAME = 'modutwin-asset-cache-v1';
const BUCKET_SEGMENT = '/3dgs-platform/';
const CACHEABLE_EXTENSIONS = new Set(['ply', 'sog', 'spz', 'splat', 'png', 'webp', 'jpg', 'jpeg']);
const MAX_ENTRIES = 160;

function cacheKeyFor(url) {
  const path = url.pathname;
  const bucketIndex = path.indexOf(BUCKET_SEGMENT);
  if (bucketIndex < 0) return null;

  const objectPath = path.slice(bucketIndex + BUCKET_SEGMENT.length).toLowerCase();
  const tail = objectPath.split('/').pop() || '';
  const dot = tail.lastIndexOf('.');
  if (dot < 0) return null;

  const ext = tail.slice(dot + 1);
  if (!CACHEABLE_EXTENSIONS.has(ext)) return null;

  return `${url.origin}${path}`;
}

async function trimCache(cache) {
  const keys = await cache.keys();
  while (keys.length > MAX_ENTRIES) {
    const key = keys.shift();
    if (!key) break;
    await cache.delete(key);
  }
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('range')) return;

  const key = cacheKeyFor(new URL(request.url));
  if (!key) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(key);
    if (cached) return cached;

    const response = await fetch(request);
    if (response.ok && response.type !== 'opaque') {
      await cache.put(key, response.clone());
      await trimCache(cache);
    }
    return response;
  })());
});
