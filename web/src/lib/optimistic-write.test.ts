import { describe, expect, it } from 'vitest';
import { restoreAfterFailedWrite } from './optimistic-write';

describe('restoreAfterFailedWrite', () => {
  it('restores the last durable value when the visible write was not persisted', () => {
    const durable = { content: 'saved' };
    const attempted = { content: 'not stored' };

    expect(restoreAfterFailedWrite(attempted, attempted, durable)).toBe(durable);
  });

  it('preserves a newer edit so its queued persistence attempt can settle it', () => {
    const durable = { content: 'saved' };
    const attempted = { content: 'first edit' };
    const newer = { content: 'second edit' };

    expect(restoreAfterFailedWrite(newer, attempted, durable)).toBe(newer);
  });
});
