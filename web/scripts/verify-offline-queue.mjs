import assert from 'node:assert/strict';
import { reconcileOfflineQueue } from '../src/offline-queue.ts';

const mutation = (id, path = `/notes/${id}`) => ({
  id,
  path,
  method: 'PUT',
  body: JSON.stringify({ id }),
  headers: { 'Idempotency-Key': `web:${id}` },
  createdAt: '2026-08-21T00:00:00Z',
});

const original = mutation('original');
const addedDuringFlush = mutation('new-comment', '/notes/note-id/comments');
assert.deepEqual(
  reconcileOfflineQueue([original], [], [original, addedDuringFlush]).map((item) => item.id),
  ['new-comment'],
  'a mutation queued while a successful flush is in flight must survive',
);

const coalescedReplacement = mutation('replacement', original.path);
assert.deepEqual(
  reconcileOfflineQueue([original], [], [coalescedReplacement]).map((item) => item.id),
  ['replacement'],
  'a newer coalesced PUT must not be removed with the snapshot item',
);

assert.deepEqual(
  reconcileOfflineQueue([original], [original], [original, addedDuringFlush]).map((item) => item.id),
  ['original', 'new-comment'],
  'retryable snapshot items and newly queued items must both remain',
);

assert.deepEqual(
  reconcileOfflineQueue([original], [original], [addedDuringFlush]).map((item) => item.id),
  ['new-comment'],
  'another tab that already removed an item must not have it resurrected',
);

console.log('Offline queue reconciliation verified');
