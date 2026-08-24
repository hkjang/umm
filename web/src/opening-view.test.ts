import { describe, expect, it } from 'vitest';
import { fittedZoom, opensSummarised, type Placed } from './opening-view';

const options = { padding: 0.3, minZoom: 0.15, maxZoom: 2.2, clusterZoom: 0.45, clusterMinNotes: 25 };
const viewport = { width: 1200, height: 780 };

/** A grid of notes the way a canvas actually fills up: across, then down. */
const grid = (count: number, columns = 40, gap = 320): Placed[] =>
  Array.from({ length: count }, (_, i) => ({
    x: (i % columns) * gap,
    y: Math.floor(i / columns) * 240,
    width: 240,
    height: 160,
  }));

describe('fittedZoom', () => {
  it('is closest in when there is nothing to fit', () => {
    expect(fittedZoom([], viewport, options)).toBe(options.maxZoom);
  });

  it('never exceeds the zoom the canvas allows', () => {
    // One small note would otherwise fit at an enormous magnification.
    const zoom = fittedZoom([{ x: 0, y: 0, width: 10, height: 10 }], viewport, options);
    expect(zoom).toBeLessThanOrEqual(options.maxZoom);
  });

  it('never falls below the zoom the canvas allows', () => {
    const zoom = fittedZoom(grid(20000), viewport, options);
    expect(zoom).toBeGreaterThanOrEqual(options.minZoom);
  });

  // The whole point: a wider spread has to come out further away, or the
  // prediction says nothing.
  it('zooms further out the more ground the notes cover', () => {
    const zooms = [4, 12, 40, 200, 2000].map((count) => fittedZoom(grid(count), viewport, options));
    for (let i = 1; i < zooms.length; i++) {
      expect(zooms[i]).toBeLessThanOrEqual(zooms[i - 1]);
    }
    // Not merely non-increasing: it has to actually move before the floor.
    expect(zooms[0]).toBeGreaterThan(zooms[2]);
  });

  // Past a certain spread every space fits at the same floor, so the zoom stops
  // distinguishing them. That is exactly why the note count is the other half
  // of the decision rather than the zoom alone.
  it('bottoms out once the notes are spread far enough', () => {
    expect(fittedZoom(grid(200), viewport, options)).toBe(options.minZoom);
    expect(fittedZoom(grid(2000), viewport, options)).toBe(options.minZoom);
  });

  it('treats a note with no stored size as occupying the default one', () => {
    const sized = fittedZoom([{ x: 0, y: 0, width: 240, height: 160 }], viewport, options);
    const unsized = fittedZoom([{ x: 0, y: 0, width: 0, height: 0 }], viewport, options);
    // A zero-size note is not a point: reading it as one predicts a closer zoom
    // than fitView will choose, and the canvas would flicker through the notes
    // on its way to the summary.
    expect(unsized).toBe(sized);
  });

  it('does not depend on where the notes are, only how far they spread', () => {
    const here = fittedZoom(grid(300), viewport, options);
    const far = fittedZoom(
      grid(300).map((n) => ({ ...n, x: n.x + 90_000, y: n.y - 40_000 })),
      viewport,
      options,
    );
    expect(far).toBeCloseTo(here, 10);
  });
});

describe('opensSummarised', () => {
  it('says no for a space small enough to read', () => {
    expect(opensSummarised(grid(6), viewport, options)).toBe(false);
  });

  // The threshold is a count as well as a zoom: a handful of notes flung far
  // apart still opens as notes, because there is nothing to summarise.
  it('says no below the note count, however far apart they are', () => {
    const scattered: Placed[] = Array.from({ length: options.clusterMinNotes - 1 }, (_, i) => ({
      x: i * 20_000,
      y: 0,
      width: 240,
      height: 160,
    }));
    expect(opensSummarised(scattered, viewport, options)).toBe(false);
  });

  it('says yes for the space that was measured taking seven seconds', () => {
    expect(opensSummarised(grid(2000), viewport, options)).toBe(true);
  });

  // A prediction that disagreed with fitView would show the wrong view for a
  // moment and then correct itself, which is the flicker this exists to avoid.
  it('agrees with the zoom it is derived from', () => {
    for (const count of [25, 60, 200, 700, 2000, 5000]) {
      const notes = grid(count);
      const zoom = fittedZoom(notes, viewport, options);
      expect(opensSummarised(notes, viewport, options)).toBe(zoom < options.clusterZoom);
    }
  });

  it('handles a viewport that has not been measured yet', () => {
    expect(opensSummarised(grid(2000), { width: 0, height: 0 }, options)).toBe(false);
  });
});
