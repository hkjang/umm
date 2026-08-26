export interface ImportedThought {
  title: string;
  content: string;
  /**
   * Where this thought was, and what it was called, in the space it came from.
   *
   * Only umm's own export carries these. A thought imported from anyone else's
   * Markdown has never been anywhere, so it is laid out in a grid like before.
   */
  sourceId?: string;
  x?: number;
  y?: number;
}

/** A connection between two thoughts, named by the ids the export wrote. */
export interface ImportedConnection {
  from: string;
  to: string;
  relation: string;
}

export interface ImportedDocument {
  thoughts: ImportedThought[];
  connections: ImportedConnection[];
}

export interface ImportThoughtsResult {
  created: number;
  failed: ImportedThought[];
}

/** Bounds one import so a large vault cannot flood a canvas in a single click. */
export const maxImportedThoughts = 200;

const headingLine = /^#{1,6}\s+\S/;
/*
 * Reading umm's own export back in.
 *
 * The exporter has always written more than the thoughts: a banner naming the
 * space and when it was taken, a metadata list under each thought carrying its
 * id, kind, source and canvas position, and — at the end — sections listing the
 * connections and the lines of thinking.
 *
 * The importer arrived later and knew none of that. It cuts at headings, so
 * exporting a space and importing it back turned the banner into a thought,
 * carried "- id: `…` - canvas: `10, 10`" into the body of every real one, and
 * titled all of them "Thought" — the word the exporter writes when a note has
 * no title of its own. A backup you cannot restore is not a backup.
 *
 * These rules apply only from the point a document announces itself as an umm
 * export. Any other Markdown is read exactly as it was before, because
 * "Connections" is an ordinary thing to title a thought and only umm's own file
 * means something particular by it.
 *
 * The announcement is a section whose whole body is the banner, wherever it
 * falls — not something near the top. The import screen appends a chosen file
 * to whatever is already in the box, so an export very often arrives second:
 * type a thought, pick your export, and a banner-near-the-top rule would miss
 * it and hand back every id and canvas position it was meant to strip.
 */
const exportBanner = /^Exported from umm at\s+\S+$/;
const exportMetadata = /^-\s+(?:id|type|source|canvas|line):\s+`/;
const exportSections = new Set(['Connections', 'Lines of thinking']);
/** `- id: `uuid`` under a thought: where it lived before. */
const exportedID = /^-\s+id:\s+`([^`]+)`/m;
/** `- canvas: `x, y`` under a thought: where it sat on the canvas. */
const exportedCanvas = /^-\s+canvas:\s+`\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*`/m;
/** A line of the Connections section: `` `a` --relates--> `b` ``. */
const exportedConnection = /^-\s+`([^`]+)`\s*--([a-z_-]+)-->\s*`([^`]+)`/;

/** The heading the exporter writes for a thought that has no title. */
const untitledThought = 'Thought';

/**
 * Whether this section is umm's export banner and nothing else.
 *
 * Requiring the banner to be the entire body is what keeps someone's own note
 * about umm from being read as one: a thought that quotes the phrase says other
 * things too.
 */
function isExportBanner(content: string): boolean {
  return exportBanner.test(content.trim());
}

/** Drops the trailing metadata list the exporter writes under each thought. */
function withoutExportMetadata(content: string): string {
  const lines = content.split('\n');
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1].trim();
    if (line === '' || exportMetadata.test(line)) {
      end -= 1;
      continue;
    }
    break;
  }
  return lines.slice(0, end).join('\n').trim();
}

const thematicBreak = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

/**
 * splitMarkdownThoughts turns a Markdown document into one thought per section.
 *
 * Sections are cut at headings and thematic breaks, which is how people already
 * separate ideas in a note file. A document with neither falls back to blank
 * line separated blocks, so a plain list of paragraphs still imports as
 * separate thoughts instead of one wall of text.
 */
export function readMarkdownDocument(source: string): ImportedDocument {
  const lines = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  const structured = lines.some((line) => headingLine.test(line) || thematicBreak.test(line));
  const blocks: string[][] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.some((line) => line.trim() !== '')) blocks.push(current);
    current = [];
  };

  if (structured) {
    let insideFence = false;
    for (const line of lines) {
      // A heading inside a fenced code block is content, not a section break.
      if (/^\s*(?:```|~~~)/.test(line)) insideFence = !insideFence;
      if (!insideFence && thematicBreak.test(line)) {
        flush();
        continue;
      }
      if (!insideFence && headingLine.test(line)) {
        flush();
      }
      current.push(line);
    }
    flush();
  } else {
    let blank = 0;
    for (const line of lines) {
      if (line.trim() === '') {
        blank += 1;
        if (blank >= 1 && current.length > 0) flush();
        continue;
      }
      blank = 0;
      current.push(line);
    }
    flush();
  }

  // Set once the banner is seen, and stays set: a document may hold several
  // exports one after another, which is exactly what picking two files makes.
  let ummExport = false;
  const thoughts: ImportedThought[] = [];
  const connections: ImportedConnection[] = [];
  for (const block of blocks) {
    const body = block.join('\n').trim();
    if (!body) continue;
    const [first, ...rest] = body.split('\n');
    let title = headingLine.test(first) ? first.replace(/^#{1,6}\s+/, '').trim() : '';
    let content = title ? rest.join('\n').trim() : body;
    let carried: Partial<ImportedThought> = {};

    if (isExportBanner(content)) {
      // The banner is umm describing the file, not a thought in it. It also
      // marks everything after it as umm's own writing.
      ummExport = true;
      continue;
    }

    if (ummExport) {
      // The connections and the lines of thinking describe the space rather
      // than being thoughts someone had in it.
      if (title === 'Connections') {
        // Kept rather than dropped: the thoughts come back without them, and
        // on this canvas what a thought is joined to is half of what it means.
        for (const line of content.split('\n')) {
          const found = exportedConnection.exec(line.trim());
          if (found) connections.push({ from: found[1], to: found[3], relation: found[2] });
        }
        continue;
      }
      if (exportSections.has(title)) continue;
      const id = exportedID.exec(content)?.[1];
      const canvas = exportedCanvas.exec(content);
      if (id) carried = { sourceId: id };
      if (canvas) carried = { ...carried, x: Number(canvas[1]), y: Number(canvas[2]) };
      content = withoutExportMetadata(content);
      // A thought that had no title gets one from the exporter; giving it back
      // would name every restored thought "Thought".
      if (title === untitledThought) title = '';
      if (content === '') continue;
    }

    // A heading with nothing under it still carries an idea, so keep the
    // heading itself as the content rather than dropping the section.
    thoughts.push({ title, content: content || title, ...carried });
  }
  return { thoughts: thoughts.filter((thought) => thought.content !== ''), connections };
}

/**
 * The thoughts alone, for callers that have no use for the connections.
 *
 * Kept as its own name because most of the codebase — and every test written
 * before umm could read its own export — asks only this question.
 */
export function splitMarkdownThoughts(source: string): ImportedThought[] {
  return readMarkdownDocument(source).thoughts;
}

/** Rebuilds a retryable Markdown draft from thoughts that were not imported. */
export function formatImportedThoughts(thoughts: ImportedThought[]) {
  return thoughts
    .map((thought) => {
      if (!thought.title) return thought.content;
      if (thought.content === thought.title) return `# ${thought.title}`;
      return `# ${thought.title}\n\n${thought.content}`;
    })
    .join('\n\n---\n\n');
}

/** Lays imported thoughts out in a readable grid starting at the given origin. */
export function importLayout(index: number, originX: number, originY: number, columns = 4) {
  return {
    x: originX + (index % columns) * 280,
    y: originY + Math.floor(index / columns) * 200,
  };
}
