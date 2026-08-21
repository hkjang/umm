import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
console.log(`PWA precache verified: ${files.size} build assets`);
