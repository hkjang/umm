import assert from 'node:assert/strict';
import {
  commentMutationForbiddenProblem,
  isTerminalOfflineRejection,
  mergeOfflineQueues,
  noteReadOnlyProblem,
  reconcileOfflineQueue,
} from '../src/offline-queue.ts';

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

const lateLegacyMutation = mutation('late-legacy', '/notes/legacy');
lateLegacyMutation.createdAt = '2026-08-21T00:00:01Z';
assert.deepEqual(
  mergeOfflineQueues([original], [lateLegacyMutation]).map((item) => item.id),
  ['original', 'late-legacy'],
  'a legacy mutation appended after the account queue was created must survive migration',
);

const newerCoalescedUpdate = mutation('newer-update', original.path);
newerCoalescedUpdate.createdAt = '2026-08-21T00:00:02Z';
assert.deepEqual(
  mergeOfflineQueues([original], [newerCoalescedUpdate]).map((item) => item.id),
  ['newer-update'],
  'migration must retain the newest coalesced update across queue generations',
);

assert.equal(isTerminalOfflineRejection(403, noteReadOnlyProblem), true, 'a typed read-only response must remove an impossible mutation');
assert.equal(
  isTerminalOfflineRejection(403, commentMutationForbiddenProblem),
  true,
  'a typed forbidden comment mutation must not block later offline changes',
);
assert.equal(isTerminalOfflineRejection(403), false, 'generic authorization failures must remain queued');
assert.equal(isTerminalOfflineRejection(404), true, 'missing resources are terminal');
assert.equal(isTerminalOfflineRejection(409), false, 'version conflicts require user reconciliation');
assert.equal(isTerminalOfflineRejection(500), false, 'server failures must remain retryable');

console.log('Offline queue reconciliation verified');
