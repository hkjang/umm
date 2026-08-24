/**
 * Where arrangement puts things.
 *
 * On this canvas a position is not decoration — it is what someone remembers a
 * thought by. So every function here is written to disturb as little as it can:
 * they take account of how large each note actually is, and the one that tidies
 * overlaps moves notes the shortest distance that separates them rather than
 * rebuilding the space from scratch.
 *
 * Pure on purpose. Placement is the part of arranging that can be wrong — off by
 * a gap, overlapping at a certain count, drifting a note nobody asked to move —
 * and none of that needs a browser to catch.
 */

export interface Placeable {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Placement {
  id: string;
  x: number;
  y: number;
}

/** Breathing room between two notes, in canvas units. */
export const GAP = 36;

const sizeOf = (note: Placeable) => ({
  width: Math.max(1, note.width || 240),
  height: Math.max(1, note.height || 160),
});

const overlaps = (a: Placeable, b: Placeable, gap: number) => {
  const sa = sizeOf(a);
  const sb = sizeOf(b);
  return (
    a.x < b.x + sb.width + gap &&
    a.x + sa.width + gap > b.x &&
    a.y < b.y + sb.height + gap &&
    a.y + sa.height + gap > b.y
  );
};

/**
 * Places notes in rings around a centre, widening the ring until they fit.
 *
 * The old version divided a full turn by the number of notes at a fixed radius,
 * so eight connected thoughts sat on top of each other and a note someone had
 * made larger overlapped its neighbours regardless. The radius here comes from
 * how much room the notes actually need, and a ring that would be too crowded
 * spills into the next one out.
 */
export function ringAround(centre: Placeable, notes: Placeable[], gap = GAP): Placement[] {
  if (notes.length === 0) return [];
  const centreSize = sizeOf(centre);
  const centreX = centre.x + centreSize.width / 2;
  const centreY = centre.y + centreSize.height / 2;

  // The widest note decides the ring, so the tightest pair on it still clears.
  const widest = Math.max(...notes.map((note) => sizeOf(note).width));
  const tallest = Math.max(...notes.map((note) => sizeOf(note).height));
  const step = Math.max(widest, tallest) + gap;

  const placements: Placement[] = [];
  let placed = 0;
  let ring = 1;
  while (placed < notes.length) {
    const radius = Math.max(centreSize.width, centreSize.height) / 2 + step * ring;
    // How many fit without their boxes touching. The distance between two
    // neighbours is the chord between them, not the arc: using arc length here
    // claimed twelve notes fitted on a ring where they still overlapped.
    // chord = 2r·sin(Δθ/2) ≥ step  ⇒  Δθ ≥ 2·asin(step / 2r).
    const halfAngle = Math.asin(Math.min(1, step / (2 * radius)));
    const perRing = halfAngle >= Math.PI / 2 ? 1 : Math.max(1, Math.floor(Math.PI / halfAngle));
    const count = Math.min(perRing, notes.length - placed);
    for (let index = 0; index < count; index += 1) {
      const note = notes[placed + index];
      const size = sizeOf(note);
      // Start each ring a little turned, so rings do not line up into spokes.
      const angle = (index / count) * Math.PI * 2 + ring * 0.4;
      placements.push({
        id: note.id,
        x: Math.round(centreX + Math.cos(angle) * radius - size.width / 2),
        y: Math.round(centreY + Math.sin(angle) * radius - size.height / 2),
      });
    }
    placed += count;
    ring += 1;
  }
  return placements;
}

/**
 * Lays groups out side by side, each group packed into a column-pair.
 *
 * Sized from the notes rather than from two constants: a group holding a note
 * someone widened gets a wider lane, instead of that note lying across the group
 * beside it.
 */
export function packGroups(groups: Placeable[][], origin = { x: 0, y: 0 }, gap = GAP): Placement[] {
  const placements: Placement[] = [];
  let laneX = origin.x;

  for (const group of groups) {
    if (group.length === 0) continue;
    const columns = group.length > 3 ? 2 : 1;
    const columnWidth = Math.max(...group.map((note) => sizeOf(note).width)) + gap;
    let rowY = origin.y;
    let rowHeight = 0;

    group.forEach((note, index) => {
      const column = index % columns;
      if (column === 0 && index > 0) {
        rowY += rowHeight + gap;
        rowHeight = 0;
      }
      placements.push({ id: note.id, x: Math.round(laneX + column * columnWidth), y: Math.round(rowY) });
      rowHeight = Math.max(rowHeight, sizeOf(note).height);
    });

    laneX += columnWidth * columns + gap * 2;
  }
  return placements;
}

/**
 * Separates notes that sit on top of each other, moving each as little as it can.
 *
 * This is the arrangement that keeps a layout rather than replacing one. Notes
 * that already have room are not touched at all — they are not returned — so
 * tidying a crowded corner leaves the rest of the space exactly where the person
 * put it.
 *
 * Earlier notes hold their ground and later ones give way, which makes the result
 * the same every time it runs on the same input.
 */
export function spreadOverlaps(notes: Placeable[], gap = GAP, maxPasses = 24): Placement[] {
  const working = notes.map((note) => ({ ...note }));
  const moved = new Map<string, Placement>();

  for (let pass = 0; pass < maxPasses; pass += 1) {
    let collided = false;
    for (let i = 0; i < working.length; i += 1) {
      for (let j = i + 1; j < working.length; j += 1) {
        const a = working[i];
        const b = working[j];
        if (!overlaps(a, b, gap)) continue;
        collided = true;

        const sa = sizeOf(a);
        const sb = sizeOf(b);
        const dx = b.x + sb.width / 2 - (a.x + sa.width / 2);
        const dy = b.y + sb.height / 2 - (a.y + sa.height / 2);
        // Push along whichever axis needs less movement to clear.
        const needX = (sa.width + sb.width) / 2 + gap - Math.abs(dx);
        const needY = (sa.height + sb.height) / 2 + gap - Math.abs(dy);

        if (needX < needY) {
          const direction = dx === 0 ? 1 : Math.sign(dx);
          b.x = Math.round(b.x + direction * needX);
        } else {
          const direction = dy === 0 ? 1 : Math.sign(dy);
          b.y = Math.round(b.y + direction * needY);
        }
        moved.set(b.id, { id: b.id, x: b.x, y: b.y });
      }
    }
    if (!collided) break;
  }

  // Only what actually ended up somewhere else. A note reported as moved but
  // sitting where it started would show up in undo history as a change that
  // never happened.
  const original = new Map(notes.map((note) => [note.id, note]));
  return [...moved.values()].filter((placement) => {
    const before = original.get(placement.id);
    return !before || before.x !== placement.x || before.y !== placement.y;
  });
}

/** Whether any pair in the set overlaps — what the tidy action offers to fix. */
export function hasOverlaps(notes: Placeable[], gap = GAP): boolean {
  for (let i = 0; i < notes.length; i += 1) {
    for (let j = i + 1; j < notes.length; j += 1) {
      if (overlaps(notes[i], notes[j], gap)) return true;
    }
  }
  return false;
}
