/**
 * The addresses a thought refers to.
 *
 * A note that says "참고 자료: https://…" is a note whose most useful part is
 * unreachable: the body is a textarea so that it can be edited, and text in a
 * textarea is text, not a link. Copying it out by hand is the workaround people
 * settle for.
 *
 * Pulled out here rather than written inline so the parsing — which is the part
 * that can be wrong — can be tested on its own.
 */

/** How many links a card offers before the list stops being a list. */
export const maxNoteLinks = 8;

export interface NoteLink {
  /** The address, as it will be opened. */
  href: string;
  /** What to show for it: the host and enough path to tell two apart. */
  label: string;
}

// Only http and https. A note may contain anything, and turning arbitrary text
// into something openable is how a "link" ends up being javascript: or file:.
const pattern = /\bhttps?:\/\/[^\s<>"'()[\]{}]+/gi;

// Sentence punctuation that sits after a URL rather than inside it. A trailing
// full stop is the end of the sentence, not part of the address.
const trailing = /[.,;:!?·…]+$/;

/** Extracts the addresses a note refers to, in the order they appear. */
export function noteLinks(content: string): NoteLink[] {
  const seen = new Set<string>();
  const links: NoteLink[] = [];
  for (const match of content.matchAll(pattern)) {
    const href = match[0].replace(trailing, '');
    if (href === '' || seen.has(href)) continue;

    let parsed: URL;
    try {
      parsed = new URL(href);
    } catch {
      continue;
    }
    // Checked again after parsing, even though the pattern above already only
    // matches http and https. Removing either one on its own changes nothing —
    // tested — and removing both lets file:// through. Two cheap guards on the
    // one place where note text becomes something a browser will follow.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;

    seen.add(href);
    links.push({ href, label: labelFor(parsed) });
    if (links.length >= maxNoteLinks) break;
  }
  return links;
}

/**
 * A short name for a link.
 *
 * The host alone reads the same for every page on a site, so enough of the path
 * comes with it to tell two apart — trimmed from the front, because the end of
 * a path is the part that says which page it is.
 */
function labelFor(url: URL): string {
  const host = url.host.replace(/^www\./, '');
  const path = url.pathname.replace(/\/$/, '');
  if (path === '' || path === '/') return host;
  const full = host + path;
  if (full.length <= 42) return full;
  return host + '/…' + path.slice(path.length - (38 - host.length));
}
