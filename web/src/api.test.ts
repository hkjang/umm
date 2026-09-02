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
import { commentMutationForbiddenProblem } from './offline-queue';

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const throwStorageDenied = () => {
  throw new DOMException('storage denied', 'SecurityError');
};
// Resolves with the outcome of the next flush, whoever started it. A scheduled
// retry is nobody's promise to await, and it reports itself here.
const nextOfflineSync = () =>
  new Promise<{ synced: number; remaining: number }>((resolve) => {
    window.addEventListener('umm:offline-sync', (event) => resolve((event as CustomEvent).detail), { once: true });
  });

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
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    localStorage.clear();
    await setOfflineQueueOwner('user-1');
  });

  afterEach(() => vi.useRealTimers());

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

  it('reports a non-durable mutation when browser quota rejects the queue write', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('network down'))),
    );
    const nativeSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === 'umm:offline-mutations:v1:user-1') throw new DOMException('quota exceeded', 'QuotaExceededError');
      return nativeSetItem.call(this, key, value);
    });
    const notices: Array<{ tone: string; title: string; message: string }> = [];
    const onNotice = (event: Event) => notices.push((event as CustomEvent).detail);
    window.addEventListener('umm:notice', onNotice);

    await expect(
      api('/notes/n1', {
        method: 'PUT',
        body: '{"content":"not durable"}',
        queueIfOffline: true,
        retry: false,
      }),
    ).rejects.toMatchObject({
      status: 0,
      queued: false,
      payload: { type: 'offline-storage-unavailable' },
    });
    window.removeEventListener('umm:notice', onNotice);
    expect(offlineQueueCount()).toBe(0);
    expect(notices.at(-1)).toMatchObject({ tone: 'error', title: '오프라인 저장 실패' });
    expect(notices.at(-1)?.message).toContain('안전하게 저장하지 못했습니다');
  });

  it('keeps owner bootstrap and queue status safe when browser storage is denied', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(throwStorageDenied);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(throwStorageDenied);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(throwStorageDenied);

    expect(() => offlineQueueCount()).not.toThrow();
    expect(offlineQueueCount()).toBe(0);
    await expect(setOfflineQueueOwner('user-2')).resolves.toBeUndefined();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('network down'))),
    );
    await expect(
      api('/notes/n2', {
        method: 'PUT',
        body: '{"content":"blocked storage"}',
        queueIfOffline: true,
        retry: false,
        silent: true,
      }),
    ).rejects.toMatchObject({ payload: { type: 'offline-storage-unavailable' }, queued: false });
  });

  it('does not replace a corrupt queue with an apparently empty queue', async () => {
    const storageKey = 'umm:offline-mutations:v1:user-1';
    localStorage.setItem(storageKey, '{not-json');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('network down'))),
    );

    await expect(
      api('/notes/n3', {
        method: 'PUT',
        body: '{"content":"preserve corrupt storage"}',
        queueIfOffline: true,
        retry: false,
        silent: true,
      }),
    ).rejects.toMatchObject({ payload: { type: 'offline-storage-unavailable' }, queued: false });
    expect(localStorage.getItem(storageKey)).toBe('{not-json');
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
    await setOfflineQueueOwner('user-2');
    expect(offlineQueueCount()).toBe(0);
    await setOfflineQueueOwner('user-1');
    expect(offlineQueueCount()).toBe(1);
  });

  it('merges late legacy mutations into an existing account queue before deleting it', async () => {
    const accountMutation = {
      id: 'account-change',
      path: '/notes/account',
      method: 'PUT',
      body: '{"content":"account"}',
      headers: { 'Idempotency-Key': 'web:account-change' },
      createdAt: '2026-08-21T00:00:00.000Z',
    };
    const lateLegacyMutation = {
      id: 'late-legacy-change',
      path: '/notes/legacy',
      method: 'PUT',
      body: '{"content":"legacy"}',
      headers: { 'Idempotency-Key': 'web:late-legacy-change' },
      createdAt: '2026-08-21T00:00:01.000Z',
    };
    localStorage.setItem('umm:offline-mutations:v1:user-1', JSON.stringify([accountMutation]));
    localStorage.setItem('umm:offline-mutations:v1', JSON.stringify([lateLegacyMutation]));

    await setOfflineQueueOwner('user-1');

    expect(JSON.parse(localStorage.getItem('umm:offline-mutations:v1:user-1')!)).toEqual([
      accountMutation,
      lateLegacyMutation,
    ]);
    expect(localStorage.getItem('umm:offline-mutations:v1')).toBeNull();
    expect(offlineQueueCount()).toBe(2);
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

  it('drops a forbidden comment mutation and continues syncing later changes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('network down'))),
    );
    await api('/comments/c1/resolve', {
      method: 'PUT',
      body: '{"resolved":true}',
      queueIfOffline: true,
      silent: true,
    }).catch(() => undefined);
    await api('/notes/n2', { method: 'PUT', body: '{"content":"later"}', queueIfOffline: true, silent: true }).catch(
      () => undefined,
    );

    const replay = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(403, { type: commentMutationForbiddenProblem, detail: 'forbidden' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', replay);
    const result = await flushOfflineQueue();

    expect(result).toEqual({ synced: 1, remaining: 0 });
    expect(replay).toHaveBeenCalledTimes(2);
    expect(offlineQueueCount()).toBe(0);
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

  // Nothing else brings the flush back: the reservation clears in another tab
  // or another request, which raises no browser event, so without a timer the
  // change waits under a banner for a connection the reader already has.
  it('comes back on its own after an in-progress reservation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('network down'))),
    );
    await api('/notes/n1', { method: 'PUT', body: '{"content":"x"}', queueIfOffline: true, silent: true }).catch(
      () => undefined,
    );
    const replay = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(409, { type: 'https://umm.local/problems/idempotency-in-progress' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', replay);
    vi.useFakeTimers();

    expect(await flushOfflineQueue()).toEqual({ synced: 0, remaining: 1 });
    const retried = nextOfflineSync();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(await retried).toEqual({ synced: 1, remaining: 0 });
    expect(replay).toHaveBeenCalledTimes(2);
    expect(offlineQueueCount()).toBe(0);
  });

  // A request that throws while the browser still reports a connection is a
  // server or a network that faltered without the browser noticing, so no
  // `online` event will ever arrive to restart the flush.
  it('comes back on its own after a request failed with the connection intact', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('network down'))),
    );
    await api('/notes/n1', { method: 'PUT', body: '{"content":"x"}', queueIfOffline: true, silent: true }).catch(
      () => undefined,
    );
    const replay = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('connection reset'))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', replay);
    vi.useFakeTimers();

    expect(await flushOfflineQueue()).toEqual({ synced: 0, remaining: 1 });
    const retried = nextOfflineSync();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await retried).toEqual({ synced: 1, remaining: 0 });
    expect(offlineQueueCount()).toBe(0);
  });

  // Replaying a conflicted change answers 409 for as long as it is queued, and
  // every repeat reopens the merge dialog over whatever the person had typed.
  it('holds a change whose conflict the reader is already deciding', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('network down'))),
    );
    await api('/notes/n1', { method: 'PUT', body: '{"content":"mine"}', queueIfOffline: true, silent: true }).catch(
      () => undefined,
    );
    const conflicts: Event[] = [];
    const listener = (event: Event) => conflicts.push(event);
    window.addEventListener('umm:offline-conflict', listener);
    const replay = vi.fn(() => Promise.resolve(jsonResponse(409, { detail: 'conflict' })));
    vi.stubGlobal('fetch', replay);

    expect((await flushOfflineQueue()).remaining).toBe(1);
    expect((await flushOfflineQueue()).remaining).toBe(1);
    window.removeEventListener('umm:offline-conflict', listener);

    expect(replay).toHaveBeenCalledTimes(1);
    expect(conflicts).toHaveLength(1);

    // Deciding, either way, discards the mutation and releases the hold.
    const mutationID = (conflicts[0] as CustomEvent).detail.item.id;
    await discardOfflineMutation(mutationID);
    expect(offlineQueueCount()).toBe(0);
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
