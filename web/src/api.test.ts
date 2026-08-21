import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  APIError,
  discardOfflineMutation,
  flushOfflineQueue,
  offlineQueueCount,
  problemMessage,
  setOfflineQueueOwner,
} from './api';
import { setLocale } from './i18n/translate';

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('problemMessage', () => {
  beforeEach(() => setLocale('en'));
  afterEach(() => setLocale('ko'));

  // The API writes its messages in Korean, so a known RFC 9457 type is mapped to
  // a translated title rather than shown as-is to an English reader.
  it('translates a known problem type', () => {
    expect(problemMessage({ type: 'https://umm.local/problems/rate-limited', detail: '요청이 많습니다' })).toBe(
      'Too many requests',
    );
  });

  it('falls back to the server detail for an unknown type', () => {
    expect(problemMessage({ type: 'https://umm.local/problems/unheard-of', detail: 'server said this' })).toBe(
      'server said this',
    );
    expect(problemMessage({ error: 'legacy field' })).toBe('legacy field');
    expect(problemMessage({})).toBe('');
  });
});

describe('offline queue', () => {
  beforeEach(() => {
    localStorage.clear();
    setOfflineQueueOwner('user-1');
    vi.restoreAllMocks();
  });

  it('queues a mutation when the network is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('network down'))),
    );
    await expect(
      api('/spaces/s1/notes', { method: 'POST', body: '{"content":"x"}', queueIfOffline: true, silent: true }),
    ).rejects.toBeInstanceOf(APIError);
    expect(offlineQueueCount()).toBe(1);
  });

  // Two people signing in on one browser must not inherit each other's pending
  // changes, so the queue is keyed by account.
  it('keeps each account queue separate', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('network down'))),
    );
    await api('/a', { method: 'POST', body: '{}', queueIfOffline: true, silent: true }).catch(() => undefined);
    expect(offlineQueueCount()).toBe(1);
    setOfflineQueueOwner('user-2');
    expect(offlineQueueCount()).toBe(0);
    setOfflineQueueOwner('user-1');
    expect(offlineQueueCount()).toBe(1);
  });

  it('collapses repeated updates to the same resource', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('network down'))),
    );
    for (const content of ['one', 'two', 'three']) {
      await api('/notes/n1', {
        method: 'PUT',
        body: JSON.stringify({ content }),
        queueIfOffline: true,
        silent: true,
      }).catch(() => undefined);
    }
    expect(offlineQueueCount()).toBe(1);
  });

  it('drains the queue once the network returns', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('network down'))),
    );
    await api('/a', { method: 'POST', body: '{}', queueIfOffline: true, silent: true }).catch(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse(201, { ok: true }))),
    );
    const result = await flushOfflineQueue();
    expect(result).toEqual({ synced: 1, remaining: 0 });
    expect(offlineQueueCount()).toBe(0);
  });

  // A rejected change would otherwise be retried forever on every reconnect.
  it('drops a permanently rejected change instead of retrying it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('network down'))),
    );
    await api('/a', { method: 'POST', body: '{}', queueIfOffline: true, silent: true }).catch(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse(400, { detail: 'nope' }))),
    );
    const result = await flushOfflineQueue();
    expect(result.remaining).toBe(0);
  });

  it('keeps a conflicted change for the merge dialog', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('network down'))),
    );
    await api('/notes/n1', { method: 'PUT', body: '{}', queueIfOffline: true, silent: true }).catch(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse(409, { detail: 'conflict' }))),
    );
    const result = await flushOfflineQueue();
    expect(result.remaining).toBe(1);
    discardOfflineMutation(JSON.parse(localStorage.getItem('umm:offline-mutations:v1:user-1')!)[0].id);
    expect(offlineQueueCount()).toBe(0);
  });

  // Reconnecting can trigger the browser's own online event and a manual sync
  // at the same time; replaying one mutation twice used to collide with its own
  // idempotency reservation and raise a false conflict.
  it('collapses concurrent flushes into a single pass', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('network down'))),
    );
    await api('/a', { method: 'POST', body: '{}', queueIfOffline: true, silent: true }).catch(() => undefined);
    let replays = 0;
    vi.stubGlobal('fetch', () => {
      replays += 1;
      return new Promise((resolve) => setTimeout(() => resolve(jsonResponse(201, {})), 20));
    });
    const [first, second] = await Promise.all([flushOfflineQueue(), flushOfflineQueue()]);
    expect(replays).toBe(1);
    expect(first).toBe(second);
    expect(offlineQueueCount()).toBe(0);
  });

  it('retries an in-progress reservation instead of raising a conflict', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('network down'))),
    );
    await api('/notes/n1', { method: 'PUT', body: '{}', queueIfOffline: true, silent: true }).catch(() => undefined);
    const conflicts: Event[] = [];
    const listener = (event: Event) => conflicts.push(event);
    window.addEventListener('umm:offline-conflict', listener);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse(409, { type: 'https://umm.local/problems/idempotency-in-progress' }))),
    );
    const result = await flushOfflineQueue();
    window.removeEventListener('umm:offline-conflict', listener);
    expect(result.remaining).toBe(1);
    expect(conflicts).toHaveLength(0);
  });

  it('attaches an idempotency key so a retry cannot duplicate the change', async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal('fetch', (_input: unknown, init: RequestInit) => {
      calls.push(init);
      return Promise.resolve(jsonResponse(201, {}));
    });
    await api('/spaces/s1/notes', { method: 'POST', body: '{}', queueIfOffline: true, silent: true });
    expect((calls[0].headers as Headers).get('Idempotency-Key')).toMatch(/^web:/);
  });
});
