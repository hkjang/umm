import { getViewportForBounds } from '@xyflow/react';

/**
 * Whether a space will open summarised, worked out before anything is drawn.
 *
 * The canvas replaces the post-its with one shape per group once the zoom drops
 * below reading distance. Which side of that line a space opens on was only
 * discovered after React Flow had mounted every note and measured it — so a
 * space of two thousand notes built two thousand post-its, measured them, and
 * then threw them all away for a handful of cluster boxes. Measured in a
 * browser: 2000 nodes mounted at +5.5s, replaced by 1 at +8.6s, on a request
 * the server answered in 85ms.
 *
 * None of that measuring was needed. Where the notes are is already known when
 * they arrive, and the zoom that fits them is arithmetic on those coordinates.
 *
 * The arithmetic is React Flow's own — the same function fitView uses — rather
 * than a copy of it here. A copy would agree today and drift the first time
 * they change how padding resolves, and the disagreement would show up as a
 * canvas that flickers through two thousand notes on the way to the view it
 * was always going to settle on.
 */

export interface Placed {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/** The zoom fitView will settle on for these notes in this viewport. */
export function fittedZoom(
  notes: Placed[],
  viewport: Viewport,
  options: { padding: number; minZoom: number; maxZoom: number },
): number {
  if (notes.length === 0 || viewport.width <= 0 || viewport.height <= 0) return options.maxZoom;

  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const note of notes) {
    // A note with no stored size still occupies the default one; treating it as
    // a point would shrink the bounds and predict a closer zoom than fitView
    // will actually choose.
    const width = note.width || 240;
    const height = note.height || 160;
    left = Math.min(left, note.x);
    top = Math.min(top, note.y);
    right = Math.max(right, note.x + width);
    bottom = Math.max(bottom, note.y + height);
  }

  const bounds = { x: left, y: top, width: right - left, height: bottom - top };
  if (bounds.width <= 0 || bounds.height <= 0) return options.maxZoom;

  return getViewportForBounds(
    bounds,
    viewport.width,
    viewport.height,
    options.minZoom,
    options.maxZoom,
    options.padding,
  ).zoom;
}

/**
 * Whether the canvas should open in the summarised view.
 *
 * Both conditions have to hold, and both are the ones the canvas itself uses:
 * a space small enough to read is never summarised however far out it starts,
 * and a space that opens close in shows its notes.
 */
export function opensSummarised(
  notes: Placed[],
  viewport: Viewport,
  options: { padding: number; minZoom: number; maxZoom: number; clusterZoom: number; clusterMinNotes: number },
): boolean {
  if (notes.length < options.clusterMinNotes) return false;
  return fittedZoom(notes, viewport, options) < options.clusterZoom;
}
