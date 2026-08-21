import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'dist/asset-manifest.json'), 'utf8'));
const files = new Set();
for (const entry of Object.values(manifest)) {
  if (entry.file) files.add(entry.file);
  for (const file of entry.css || []) files.add(file);
  for (const file of entry.assets || []) files.add(file);
}
for (const file of files) {
  if (!existsSync(resolve(root, 'dist', file))) throw new Error(`missing PWA asset: ${file}`);
}
for (const extension of ['.js', '.css', '.woff2']) {
  if (![...files].some((file) => file.endsWith(extension))) throw new Error(`asset manifest has no ${extension} entry`);
}
const worker = readFileSync(resolve(root, 'dist/umm-sw.js'), 'utf8');
if (!worker.includes("BUILD_MANIFEST = '/asset-manifest.json'") || !worker.includes('cache.addAll')) {
  throw new Error('service worker does not precache the build manifest assets');
}
if (/\bself\.skipWaiting\s*\(/.test(worker) || /\bself\.clients\.claim\s*\(/.test(worker)) {
  throw new Error('service worker must not replace active clients before their versioned chunks are retired');
}

// Execute the built worker with a minimal service-worker environment. A
// navigation to a same-origin JSON/SVG resource must not replace the cached
// HTML app shell, while a successful app-route navigation should refresh it.
const handlers = new Map();
let cachedShell = new Response('<!doctype html><title>cached shell</title>', {
  headers: { 'content-type': 'text/html; charset=utf-8' },
});
let networkResponse;
const cache = {
  put: async (key, response) => {
    if (key === '/') cachedShell = response.clone();
  },
  addAll: async () => {},
};
const cacheStorage = {
  open: async () => cache,
  keys: async () => [],
  delete: async () => true,
  match: async (key) => (key === '/' ? cachedShell.clone() : undefined),
};
const workerScope = {
  location: { origin: 'https://umm.test' },
  addEventListener: (type, handler) => handlers.set(type, handler),
};
runInNewContext(worker, {
  self: workerScope,
  caches: cacheStorage,
  fetch: async () => networkResponse.clone(),
  URL,
  Set,
});
const navigate = async (path, response) => {
  networkResponse = response;
  let handled;
  handlers.get('fetch')({
    request: { method: 'GET', mode: 'navigate', url: `https://umm.test${path}` },
    respondWith: (value) => {
      handled = value;
    },
  });
  if (!handled) throw new Error(`navigation was not handled: ${path}`);
  return handled;
};

await navigate(
  '/manifest.webmanifest',
  new Response('{"name":"umm"}', { headers: { 'content-type': 'application/manifest+json' } }),
);
if (!(await cachedShell.clone().text()).includes('cached shell')) {
  throw new Error('a non-HTML navigation replaced the cached app shell');
}
await navigate(
  '/today',
  new Response('<!doctype html><title>fresh shell</title>', {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  }),
);
if (!(await cachedShell.clone().text()).includes('fresh shell')) {
  throw new Error('an HTML navigation did not refresh the cached app shell');
}
console.log(`PWA precache verified: ${files.size} build assets`);
