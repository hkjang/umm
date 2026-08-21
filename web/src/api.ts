import { showError } from './ui-notifications';

export interface Meta {
  serviceName: string;
  version: string;
  oidcEnabled: boolean;
  dreamEnabled: boolean;
  dreamAllowUserDisable: boolean;
  mcpProtocol: string;
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  email: string;
  role: 'user' | 'team_lead' | 'admin';
  teamId?: string;
  active: boolean;
}

export interface Space {
  id: string;
  ownerId: string;
  name: string;
  color: string;
  aiExcluded: boolean;
}

export interface ThoughtNote {
  id: string;
  spaceId: string;
  authorId: string;
  content: string;
  title: string;
  color: string;
  kind: string;
  source: 'user' | 'dream' | 'api' | 'mcp';
  aiExcluded: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  relatedCount: number;
}

export interface NoteComment {
  id: string;
  noteId: string;
  authorId: string;
  author: string;
  username: string;
  parentId?: string;
  body: string;
  mentions: string[];
  resolvedAt?: string;
  resolvedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ThoughtEdge {
  id: string;
  spaceId: string;
  source: string;
  target: string;
  relation: string;
}

export interface NoteSearchResult {
  id: string;
  spaceId: string;
  spaceName: string;
  title: string;
  content: string;
  kind: string;
  updatedAt: string;
  score: number;
  reason: string;
}

export type EdgeStyle = 'bezier' | 'smoothstep' | 'straight';

export interface Preferences {
  dream_enabled: boolean;
  dream_frequency: string;
  dream_style: string;
  dream_notifications: boolean;
  include_old_notes: boolean;
  dream_pause_until?: string;
  theme: string;
  locale: string;
  edge_style: EdgeStyle;
  review_digest: boolean;
}

export class APIError extends Error {
  constructor(public status: number, message: string, public payload: Record<string, any> = {}, public queued = false) { super(message); }
}

export interface APIOptions extends RequestInit {
  silent?: boolean;
  queueIfOffline?: boolean;
  retry?: boolean;
}

interface OfflineMutation {
  id: string;
  path: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
  createdAt: string;
}

const offlineKey = 'umm:offline-mutations:v1';
const offlineOwnerKey = 'umm:offline-owner:v1';
const mutationMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const requestID = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const queueStorageKey = () => `${offlineKey}:${localStorage.getItem(offlineOwnerKey) || 'anonymous'}`;

export function setOfflineQueueOwner(userId?: string) {
  if (userId) {
    const target = `${offlineKey}:${userId}`;
    const legacy = localStorage.getItem(offlineKey);
    if (legacy && !localStorage.getItem(target)) localStorage.setItem(target, legacy);
    localStorage.removeItem(offlineKey);
    localStorage.setItem(offlineOwnerKey, userId);
  } else {
    localStorage.removeItem(offlineOwnerKey);
  }
  window.dispatchEvent(new CustomEvent('umm:offline-queue', { detail: { count: offlineQueueCount() } }));
}

function loadOfflineQueue(): OfflineMutation[] {
  try {
    const value = JSON.parse(localStorage.getItem(queueStorageKey()) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function saveOfflineQueue(items: OfflineMutation[]) {
  localStorage.setItem(queueStorageKey(), JSON.stringify(items));
  window.dispatchEvent(new CustomEvent('umm:offline-queue', { detail: { count: items.length } }));
}

function enqueueOffline(item: OfflineMutation) {
  let items = loadOfflineQueue();
  if (item.method === 'PUT' || item.method === 'PATCH') {
    items = items.filter((queued) => !(queued.path === item.path && queued.method === item.method));
  }
  if (items.length >= 100) return false;
  items.push(item);
  saveOfflineQueue(items);
  return true;
}

export const offlineQueueCount = () => loadOfflineQueue().length;

export function discardOfflineMutation(id?: string) {
  if (!id) return;
  saveOfflineQueue(loadOfflineQueue().filter((item) => item.id !== id));
}

const retryableOfflineStatus = (status: number) => status === 408 || status === 425 || status === 429 || status >= 500;

async function fetchAPI(path: string, requestOptions: RequestInit, retry: boolean): Promise<Response> {
  try {
    return await fetch(`/api/v1${path}`, { credentials: 'same-origin', ...requestOptions });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    if (!retry) throw cause;
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    return fetch(`/api/v1${path}`, { credentials: 'same-origin', ...requestOptions });
  }
}

export async function api<T>(path: string, options: APIOptions = {}): Promise<T> {
  const { silent = false, queueIfOffline = false, retry, ...requestOptions } = options;
  const method = (requestOptions.method || 'GET').toUpperCase();
  const headers = new Headers(requestOptions.headers);
  if (requestOptions.body) headers.set('Content-Type', 'application/json');
  if (queueIfOffline && mutationMethods.has(method) && !headers.has('Idempotency-Key')) headers.set('Idempotency-Key', `web:${requestID()}`);
  const normalizedOptions = { ...requestOptions, method, headers };
  let response: Response;
  try {
    response = await fetchAPI(path, normalizedOptions, retry ?? (method === 'GET' || headers.has('Idempotency-Key')));
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    if (queueIfOffline && mutationMethods.has(method) && typeof requestOptions.body !== 'object') {
      const safeHeaders: Record<string, string> = {};
      for (const name of ['Content-Type', 'Idempotency-Key']) {
        const value = headers.get(name);
        if (value) safeHeaders[name] = value;
      }
      const queued = enqueueOffline({ id: requestID(), path, method, body: requestOptions.body as string | undefined, headers: safeHeaders, createdAt: new Date().toISOString() });
      if (!queued) {
        const error = new APIError(0, '오프라인 보관함이 100개로 가득 찼습니다. 연결 후 동기화를 완료하고 다시 시도해 주세요.');
        if (!silent) showError(error.message, '오프라인 보관함 가득 참', `api:${path}:queue-full`);
        throw error;
      }
      const error = new APIError(0, '오프라인 보관함에 저장했습니다. 연결되면 자동으로 다시 시도합니다.', {}, true);
      if (!silent) showError(error.message, '오프라인 저장', `api:${path}:queued`);
      throw error;
    }
    const error = new APIError(0, '서버에 연결할 수 없습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.');
    if (!silent) showError(error.message, '연결 오류', `api:${path}:network`);
    throw error;
  }
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new APIError(response.status, payload.detail || payload.error || `요청에 실패했습니다 (${response.status})`, payload);
    if (!silent) showError(error.message, '요청 오류', `api:${path}:${response.status}`);
    throw error;
  }
  return payload as T;
}

export async function flushOfflineQueue() {
  const queued = loadOfflineQueue();
  if (queued.length === 0 || !navigator.onLine) return { synced: 0, remaining: queued.length };
  const remaining: OfflineMutation[] = [];
  let synced = 0;
  for (let index = 0; index < queued.length; index += 1) {
    const item = queued[index];
    try {
      const response = await fetch(`/api/v1${item.path}`, { credentials: 'same-origin', method: item.method, body: item.body, headers: item.headers });
      if (response.ok) {
        synced += 1;
        continue;
      }
      const payload = await response.json().catch(() => ({}));
      if (response.status === 409) {
        remaining.push(item);
        window.dispatchEvent(new CustomEvent('umm:offline-conflict', { detail: { item, payload } }));
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        remaining.push(item, ...queued.slice(index + 1));
        break;
      }
      if (response.status >= 400 && response.status < 500 && !retryableOfflineStatus(response.status)) {
        const reason = payload.detail || payload.error || `서버가 변경을 거부했습니다 (${response.status}).`;
        showError(reason, '오프라인 변경을 적용하지 못했습니다', `offline:${item.id}:rejected`);
        window.dispatchEvent(new CustomEvent('umm:offline-rejected', { detail: { item, payload, status: response.status } }));
        continue;
      }
      remaining.push(item);
    } catch {
      remaining.push(...queued.slice(index));
      break;
    }
  }
  saveOfflineQueue(remaining);
  window.dispatchEvent(new CustomEvent('umm:offline-sync', { detail: { synced, remaining: remaining.length } }));
  return { synced, remaining: remaining.length };
}

export const json = (method: string, body?: unknown): APIOptions => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});
