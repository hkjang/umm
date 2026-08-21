const CACHE = 'umm-shell-v0.8.0';
const BUILD_MANIFEST = '/asset-manifest.json';
const SHELL = ['/', '/manifest.webmanifest'];

const assetURL = (path) => path.startsWith('/') ? path : `/${path}`;

async function precacheShell() {
  const cache = await caches.open(CACHE);
  const manifestResponse = await fetch(BUILD_MANIFEST, { cache: 'no-store' });
  if (!manifestResponse.ok) throw new Error('build asset manifest unavailable');
  const manifest = await manifestResponse.clone().json();
  const buildAssets = new Set();
  for (const entry of Object.values(manifest)) {
    if (entry.file) buildAssets.add(assetURL(entry.file));
    for (const path of entry.css || []) buildAssets.add(assetURL(path));
    for (const path of entry.assets || []) buildAssets.add(assetURL(path));
  }
  await cache.put(BUILD_MANIFEST, manifestResponse);
  await cache.addAll([...SHELL, ...buildAssets]);
}

self.addEventListener('install', (event) => {
  // Do not skipWaiting: an older open page still imports its versioned lazy
  // chunks from the previous cache. The new worker activates after those
  // clients close, then it is safe to retire the old shell.
  event.waitUntil(precacheShell());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('umm-shell-') && key !== CACHE).map((key) => caches.delete(key)))));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/mcp') return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) caches.open(CACHE).then((cache) => cache.put('/', response.clone()));
      return response;
    }).catch(() => caches.match('/', { ignoreVary: true })));
    return;
  }
  event.respondWith(caches.match(request, { ignoreVary: true }).then((cached) => cached || fetch(request).then((response) => {
    if (response.ok && /\.(?:js|css|woff2?|png|svg)$/.test(url.pathname)) caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
    return response;
  })));
});
