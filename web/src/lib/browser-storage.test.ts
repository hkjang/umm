import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readLocalStorage,
  readSessionStorage,
  removeLocalStorage,
  writeLocalStorage,
  writeSessionStorage,
} from './browser-storage';

describe('browser storage guards', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns an unavailable result when storage reads are denied', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('storage denied', 'SecurityError');
    });

    expect(readLocalStorage('local')).toEqual({ available: false, value: null });
    expect(readSessionStorage('session')).toEqual({ available: false, value: null });
  });

  it('reports denied writes and deletes without throwing', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('storage denied', 'SecurityError');
    });

    expect(writeLocalStorage('local', 'value')).toBe(false);
    expect(writeSessionStorage('session', 'value')).toBe(false);
    expect(removeLocalStorage('local')).toBe(false);
  });
});
