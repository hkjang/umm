import { describe, expect, it } from 'vitest';
import { GAP, hasOverlaps, packGroups, ringAround, spreadOverlaps, type Placeable } from './layout';

const note = (id: string, x: number, y: number, width = 240, height = 160): Placeable => ({
  id,
  x,
  y,
  width,
  height,
});

/** Re-reads placements back onto the notes so overlap can be judged on the result. */
const applied = (notes: Placeable[], placements: { id: string; x: number; y: number }[]): Placeable[] => {
  const byID = new Map(placements.map((p) => [p.id, p]));
  return notes.map((n) => ({ ...n, ...byID.get(n.id) }));
};

describe('ringAround', () => {
  const centre = note('centre', 0, 0);

  it('places nothing when there is nothing to place', () => {
    expect(ringAround(centre, [])).toEqual([]);
  });

  // The old placement divided one turn by the number of notes at a fixed radius,
  // so a well-connected thought buried its neighbours in each other.
  it('keeps many notes clear of one another', () => {
    const around = Array.from({ length: 12 }, (_, i) => note(`n${i}`, 0, 0));
    const placed = applied(around, ringAround(centre, around));
    expect(hasOverlaps(placed)).toBe(false);
  });

  it('keeps them clear of the centre too', () => {
    const around = Array.from({ length: 6 }, (_, i) => note(`n${i}`, 0, 0));
    const placed = applied(around, ringAround(centre, around));
    expect(hasOverlaps([centre, ...placed])).toBe(false);
  });

  // A note someone made larger used to lie across its neighbours, because the
  // radius was a constant and took no account of size.
  it('gives a resized note the room it needs', () => {
    const around = [note('wide', 0, 0, 620, 420), note('a', 0, 0), note('b', 0, 0), note('c', 0, 0)];
    const placed = applied(around, ringAround(centre, around));
    expect(hasOverlaps(placed)).toBe(false);
  });

  it('places every note it was given', () => {
    const around = Array.from({ length: 9 }, (_, i) => note(`n${i}`, 0, 0));
    expect(ringAround(centre, around)).toHaveLength(9);
  });
});

describe('packGroups', () => {
  it('keeps groups from running into each other', () => {
    const groups = [
      Array.from({ length: 5 }, (_, i) => note(`a${i}`, 0, 0)),
      Array.from({ length: 4 }, (_, i) => note(`b${i}`, 0, 0, 500, 300)),
      [note('c0', 0, 0)],
    ];
    const flat = groups.flat();
    const placed = applied(flat, packGroups(groups));
    expect(hasOverlaps(placed)).toBe(false);
  });

  it('places every note in every group', () => {
    const groups = [[note('a', 0, 0)], [note('b', 0, 0), note('c', 0, 0)]];
    expect(packGroups(groups)).toHaveLength(3);
  });

  it('ignores an empty group rather than leaving a gap in the lane', () => {
    const groups = [[note('a', 0, 0)], [], [note('b', 0, 0)]];
    const placed = packGroups(groups);
    expect(placed.map((p) => p.id)).toEqual(['a', 'b']);
  });
});

describe('spreadOverlaps', () => {
  // The point of this one: it keeps a layout instead of replacing it.
  it('leaves notes that already have room exactly where they are', () => {
    const notes = [note('a', 0, 0), note('b', 400, 0), note('c', 800, 0)];
    expect(spreadOverlaps(notes)).toEqual([]);
  });

  it('separates a stack', () => {
    const notes = [note('a', 0, 0), note('b', 10, 10), note('c', 20, 20)];
    const placed = applied(notes, spreadOverlaps(notes));
    expect(hasOverlaps(placed)).toBe(false);
  });

  it('separates notes sitting at exactly the same spot', () => {
    const notes = [note('a', 100, 100), note('b', 100, 100), note('c', 100, 100)];
    const placed = applied(notes, spreadOverlaps(notes));
    expect(hasOverlaps(placed)).toBe(false);
  });

  // Earlier notes hold their ground, so tidying twice does not shuffle a layout
  // that is already clear.
  it('does nothing on a second run', () => {
    const notes = [note('a', 0, 0), note('b', 30, 30), note('c', 60, 15)];
    const once = applied(notes, spreadOverlaps(notes));
    expect(spreadOverlaps(once)).toEqual([]);
  });

  it('moves only what was in the way', () => {
    const notes = [note('a', 0, 0), note('b', 20, 0), note('far', 3000, 3000)];
    const moved = spreadOverlaps(notes).map((p) => p.id);
    expect(moved).not.toContain('far');
    expect(moved).toContain('b');
  });

  it('never reports a note as moved when it did not move', () => {
    const notes = [note('a', 0, 0), note('b', 15, 15)];
    for (const placement of spreadOverlaps(notes)) {
      const before = notes.find((n) => n.id === placement.id)!;
      expect(before.x === placement.x && before.y === placement.y).toBe(false);
    }
  });

  it('respects the gap it is given', () => {
    const notes = [note('a', 0, 0), note('b', 10, 0)];
    const placed = applied(notes, spreadOverlaps(notes, 200));
    expect(hasOverlaps(placed, 200)).toBe(false);
  });

  it('handles a crowd without leaving overlaps behind', () => {
    const notes = Array.from({ length: 30 }, (_, i) => note(`n${i}`, (i % 5) * 20, Math.floor(i / 5) * 20));
    const placed = applied(notes, spreadOverlaps(notes));
    expect(hasOverlaps(placed)).toBe(false);
  });
});

describe('hasOverlaps', () => {
  it('is false for a single note and for none', () => {
    expect(hasOverlaps([])).toBe(false);
    expect(hasOverlaps([note('a', 0, 0)])).toBe(false);
  });

  it('counts the gap, not just the boxes', () => {
    // Clear of each other, but closer than the breathing room.
    const notes = [note('a', 0, 0), note('b', 240 + GAP / 2, 0)];
    expect(hasOverlaps(notes)).toBe(true);
  });
});
