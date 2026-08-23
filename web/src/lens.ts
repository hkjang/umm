/**
 * Which thoughts a lens keeps in focus.
 *
 * Structural rather than semantic on purpose. A lens built on similarity would
 * be only as good as the embedding behind it, and on umm's default backend that
 * is a character n-gram — it would group thoughts that share words and call it a
 * topic. Connections are drawn by the person, so this is exactly as good as the
 * graph they built, and it does not quietly get worse on a weaker backend.
 */
export interface LensEdge {
  source: string;
  target: string;
}

/**
 * Everything within `steps` connections of one thought, including itself.
 *
 * Connections are walked in both directions. A thought that points at the one
 * you are looking at is as much a part of its neighbourhood as one it points to,
 * and following only the arrows would drop exactly the backlinks the canvas
 * shows beside it.
 */
export function neighbourhood(noteID: string, edges: LensEdge[], steps: number): Set<string> {
  const reached = new Set([noteID]);
  if (steps < 1) return reached;

  const neighbours = new Map<string, string[]>();
  const link = (from: string, to: string) => neighbours.set(from, [...(neighbours.get(from) ?? []), to]);
  for (const edge of edges) {
    // A self-connection would otherwise add the thought to its own frontier and
    // do nothing but waste a step.
    if (edge.source === edge.target) continue;
    link(edge.source, edge.target);
    link(edge.target, edge.source);
  }

  let frontier = [noteID];
  for (let step = 0; step < steps && frontier.length > 0; step += 1) {
    const next: string[] = [];
    for (const id of frontier)
      for (const neighbour of neighbours.get(id) ?? [])
        if (!reached.has(neighbour)) {
          reached.add(neighbour);
          next.push(neighbour);
        }
    frontier = next;
  }
  return reached;
}
