export interface OfflineMutation {
  id: string;
  path: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
  createdAt: string;
}

export const noteReadOnlyProblem = 'https://umm.local/problems/note-read-only';
export const commentMutationForbiddenProblem = 'https://umm.local/problems/comment-mutation-forbidden';

const terminalForbiddenProblems = new Set([noteReadOnlyProblem, commentMutationForbiddenProblem]);

export function isTerminalOfflineRejection(status: number, problemType = ''): boolean {
  if (status === 403 && terminalForbiddenProblems.has(problemType)) return true;
  if (status < 400 || status >= 500) return false;
  return ![401, 403, 408, 409, 425, 429].includes(status);
}

// Apply the outcome of one flush snapshot to the latest queue. Items queued or
// coalesced while requests were in flight have different IDs and must survive.
export function reconcileOfflineQueue(
  snapshot: OfflineMutation[],
  retained: OfflineMutation[],
  latest: OfflineMutation[],
): OfflineMutation[] {
  const snapshotIDs = new Set(snapshot.map((item) => item.id));
  const retainedIDs = new Set(retained.map((item) => item.id));
  return latest.filter((item) => !snapshotIDs.has(item.id) || retainedIDs.has(item.id));
}

/**
 * Merge queues written by different app generations without replaying the
 * same idempotent mutation twice. Updates use the same last-write-wins rule as
 * the live queue, while unrelated mutations retain their creation order.
 */
export function mergeOfflineQueues(...queues: OfflineMutation[][]): OfflineMutation[] {
  const ordered = queues.flatMap((queue, queueIndex) =>
    queue.map((item, itemIndex) => ({ item, queueIndex, itemIndex })),
  );
  // This is a fresh migration snapshot, so sorting it in place cannot mutate a
  // caller's queue. ES2022 is still a supported build target and lacks toSorted.
  ordered.sort((left, right) => {
    const byCreatedAt = left.item.createdAt.localeCompare(right.item.createdAt);
    return byCreatedAt || left.queueIndex - right.queueIndex || left.itemIndex - right.itemIndex;
  }); // oxlint-disable-line unicorn/no-array-sort
  const seenIDs = new Set<string>();
  const merged: OfflineMutation[] = [];
  for (const { item } of ordered) {
    if (seenIDs.has(item.id)) continue;
    seenIDs.add(item.id);
    if (item.method === 'PUT' || item.method === 'PATCH') {
      const superseded = merged.findIndex((queued) => queued.path === item.path && queued.method === item.method);
      if (superseded >= 0) merged.splice(superseded, 1);
    }
    merged.push(item);
  }
  return merged;
}
