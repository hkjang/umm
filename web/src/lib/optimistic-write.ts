/**
 * Restore a durable value only if the failed request still represents what is
 * visible. A newer edit uses a different object and must get its own queued
 * persistence attempt before it can be rolled back.
 */
export function restoreAfterFailedWrite<T>(current: T | undefined, attempted: T, durable: T | undefined) {
  return current === attempted ? durable : current;
}
