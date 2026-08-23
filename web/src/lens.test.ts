import { describe, expect, it } from 'vitest';
import { neighbourhood } from './lens';

describe('neighbourhood', () => {
  const chain = [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
    { source: 'c', target: 'd' },
  ];

  it('keeps the thought itself even with no connections', () => {
    expect(neighbourhood('a', [], 3)).toEqual(new Set(['a']));
  });

  it('reaches exactly as far as it was asked to', () => {
    expect(neighbourhood('a', chain, 1)).toEqual(new Set(['a', 'b']));
    expect(neighbourhood('a', chain, 2)).toEqual(new Set(['a', 'b', 'c']));
    expect(neighbourhood('a', chain, 3)).toEqual(new Set(['a', 'b', 'c', 'd']));
  });

  // A thought pointing at the one you are looking at is as much a part of its
  // neighbourhood as one it points to. Following only the arrows would drop the
  // backlinks the canvas shows right beside it.
  it('follows connections in both directions', () => {
    expect(neighbourhood('d', chain, 1)).toEqual(new Set(['c', 'd']));
  });

  it('does not loop forever on a cycle', () => {
    const cycle = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'c', target: 'a' },
    ];
    expect(neighbourhood('a', cycle, 10)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('ignores a connection from a thought to itself', () => {
    expect(neighbourhood('a', [{ source: 'a', target: 'a' }], 2)).toEqual(new Set(['a']));
  });

  it('leaves an unconnected part of the canvas out', () => {
    const split = [...chain, { source: 'x', target: 'y' }];
    expect(neighbourhood('a', split, 9).has('x')).toBe(false);
  });

  it('treats zero steps as the thought alone', () => {
    expect(neighbourhood('b', chain, 0)).toEqual(new Set(['b']));
  });
});
