export interface OfflineMutation {
  id: string;
  path: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
  createdAt: string;
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
