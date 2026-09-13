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
  /** The name of the line of thinking this thought belonged to. */
  line?: string;
  /** What sort of thought it was: a question stays a question. */
  kind?: string;
  /** The colour someone chose for it. */
  color?: string;
}

/**
 * A line of thinking: a direction someone followed, and how it ended.
 *
 * The status and the reason are the half people lose first. A thought that was
 * tried and set aside reads exactly like a current one once the label is gone,
 * and losing why at the moment someone restores their record is the worst
 * possible time for it to go.
 */
export interface ImportedLine {
  name: string;
  status: string;
  resolution: string;
}

/** A connection between two thoughts, named by the ids the export wrote. */
export interface ImportedConnection {
  from: string;
  to: string;
  relation: string;
  /** Why the connection was drawn, in the author's own words. Absent from
   *  files exported before v0.65.0, and from connections nobody explained. */
  reason?: string;
}

export interface ImportedDocument {
  thoughts: ImportedThought[];
  connections: ImportedConnection[];
  lines: ImportedLine[];
  /** Whether this is a file umm wrote, rather than anyone's Markdown. */
  isExport: boolean;
  /** The banner line itself, so a draft rebuilt from this stays an export. */
  banner?: string;
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
 *
 * From that point the file is cut where the exporter cuts it and nowhere else.
 * The general rules read a document the way a person wrote it — every heading
 * and every horizontal rule ends a thought — but inside an export those marks
 * are usually somebody's own words. A thought holding a pasted `### Overview`,
 * or a rule between two paragraphs, was broken into pieces on the way back in,
 * and only the last piece kept the metadata: the rest arrived with no id, so
 * their connections could not be redrawn and they landed in a fresh grid in the
 * default colour, in no line of thinking. The exporter writes one `## ` per
 * thought and a `# ` only above a banner, so those two marks are the cuts.
 *
 * An export also ends. The import screen joins files with a horizontal rule,
 * and what follows the rule may be anybody's Markdown, to be read by the
 * general rules again; the export's rules stop where the export stops. The
 * rule itself cannot say which it is — a rule between two paragraphs of a
 * thought looks exactly like the one between two files — but the line before
 * it can. The exporter ends every section it writes in a line of its own: a
 * thought in its metadata list, the closing sections in a connection or a line
 * of thinking. A rule after one of those lines follows a finished section, and
 * nothing the exporter writes puts a rule there, so it is the seam between
 * files. A rule after anything else is inside a thought.
 */
const exportBanner = /^Exported from umm at\s+\S+$/;
const exportMetadata = /^-\s+(?:id|type|source|color|canvas|line):\s+`/;
const exportSections = new Set(['Connections', 'Lines of thinking']);
/** One thought's section in an export. Deeper headings belong to its body. */
const exportThoughtHeading = /^##\s+\S/;
/** The space name an export opens with — the only `#` the exporter writes. */
const exportFileHeading = /^#\s+\S/;
/** `- id: `uuid`` under a thought: where it lived before. */
const exportedID = /^-\s+id:\s+`([^`]+)`/m;
/** `- canvas: `x, y`` under a thought: where it sat on the canvas. */
const exportedCanvas = /^-\s+canvas:\s+`\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*`/m;
/** `- type: `question`` under a thought: a question is not a plain thought. */
const exportedKind = /^-\s+type:\s+`([^`]+)`/m;
/** `- color: `blue`` under a thought: the colour someone chose. */
const exportedColor = /^-\s+color:\s+`([^`]+)`/m;
/** `- line: `name` (status)` under a thought: the line it belonged to. */
const exportedLineLabel = /^-\s+line:\s+`([^`]+)`/m;
/** A line of the Lines of thinking section: `- **name** — status: why`. */
const exportedLine = /^-\s+\*\*(.+?)\*\*\s+—\s+([a-z]+)(?::\s*([\s\S]*))?$/;

/**
 * A line of the Connections section: `` `a` --relates--> `b` ``, optionally
 * followed by `(origin)` and then `— why it was drawn`.
 *
 * The origin is read past rather than captured: it says who made the
 * connection, and that is not something a file may claim on import — the same
 * rule the API enforces on a request body.
 */
const exportedConnection = /^-\s+`([^`]+)`\s*--([a-z_-]+)-->\s*`([^`]+)`(?:\s*\([a-z_-]+\))?(?:\s*—\s*(.*))?$/;

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

/**
 * Separates what somebody wrote from the list the exporter wrote under it.
 *
 * The list is read on its own rather than searched for in the whole section,
 * because a body may say `- id: \`ours-2024-11\`` about somebody's own
 * numbering — and the first match wins, so that line used to become the
 * thought's id. The real one was then never seen, and every connection drawn to
 * that thought pointed at a name nothing in the restored space answered to.
 */
function splitExportMetadata(content: string): { body: string; metadata: string } {
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
  return { body: lines.slice(0, end).join('\n').trim(), metadata: lines.slice(end).join('\n') };
}

/**
 * Whether the exporter would have written this line last in a section: the
 * metadata under a thought, a connection, or a line of thinking. Nothing the
 * exporter writes comes after one of these but the next section.
 */
function closesExportSection(line: string): boolean {
  return exportMetadata.test(line) || exportedConnection.test(line) || exportedLine.test(line);
}

/**
 * Whether a horizontal rule met here is the seam between two files rather than
 * part of a thought. See the note above exportBanner: the exporter never puts a
 * rule after a finished section, so a rule there is the import screen's.
 */
function endsExport(section: string[]): boolean {
  for (let at = section.length - 1; at >= 0; at -= 1) {
    const line = section[at].trim();
    if (line === '') continue;
    return closesExportSection(line);
  }
  return false;
}

/**
 * Whether this section is the export describing the space, rather than a
 * thought somebody happened to give the same name.
 *
 * "Connections" is an ordinary title for a thought — so is "Lines of thinking"
 * — and inside umm's own file the heading alone cannot tell the two apart. Read
 * by the heading alone, that thought is taken for the list at the end of the
 * file: its body yields no connections, and the section is dropped. The thought
 * is gone from the restore, and because its `- id:` never registered, every
 * connection drawn to it names an id no thought answers to and goes with it.
 * The one heading a person is likeliest to reuse is the one that costs them the
 * most.
 *
 * The exporter already writes the difference down. Every thought section ends
 * in the metadata list — id, type, source, colour, canvas — and neither of the
 * two closing sections ever does; their last line is a connection or a line of
 * thinking. So the tail says which this is, the same tail the metadata itself
 * is read from, and no change to the format is needed: files already saved read
 * correctly too.
 */
function describesTheSpace(title: string, content: string): boolean {
  if (!exportSections.has(title)) return false;
  const lines = content.split('\n');
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    const line = lines[at].trim();
    if (line === '') continue;
    return !exportMetadata.test(line);
  }
  return true;
}

const thematicBreak = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

/**
 * Whether this line begins a section of an export: a thought, or the space name
 * of another export appended directly after this one.
 */
function startsExportSection(lines: string[], index: number): boolean {
  if (exportThoughtHeading.test(lines[index])) return true;
  if (!exportFileHeading.test(lines[index])) return false;
  for (let next = index + 1; next < lines.length; next += 1) {
    if (lines[next].trim() === '') continue;
    return exportBanner.test(lines[next].trim());
  }
  return false;
}

/** One section as it was cut, and whether umm wrote it. */
interface Section {
  lines: string[];
  /** True from a banner to the end of that export; false for anybody's Markdown. */
  inExport: boolean;
}

/** The title and body of one section, however it was cut. */
function sectionOf(lines: string[]): { title: string; content: string } {
  const body = lines.join('\n').trim();
  const [first, ...rest] = body.split('\n');
  const title = headingLine.test(first) ? first.replace(/^#{1,6}\s+/, '').trim() : '';
  return { title, content: title ? rest.join('\n').trim() : body };
}

/**
 * Cuts a document into sections, by the general rules for anybody's Markdown
 * and by the exporter's own from a banner to the end of that export.
 *
 * `structured` is decided over the whole document rather than any one run of
 * it, so a plainly typed paragraph keeps reading as one thought when an export
 * is appended under it.
 */
function splitSections(lines: string[]): Section[] {
  const structured = lines.some((line) => headingLine.test(line) || thematicBreak.test(line));
  const blocks: Section[] = [];
  let current: string[] = [];
  let insideExport = false;
  const flush = () => {
    if (current.some((line) => line.trim() !== '')) {
      blocks.push({ lines: current, inExport: insideExport });
      // The banner is where umm's writing begins. It is found here, as its
      // section closes, so the very next line is already read by the
      // exporter's rules.
      if (isExportBanner(sectionOf(current).content)) insideExport = true;
    }
    current = [];
  };

  if (structured) {
    let insideFence = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      // A heading inside a fenced code block is content, not a section break.
      if (/^\s*(?:```|~~~)/.test(line)) insideFence = !insideFence;
      if (insideFence) {
        current.push(line);
        continue;
      }
      if (insideExport) {
        if (thematicBreak.test(line) && endsExport(current)) {
          // The seam between two files. What follows is read as it was
          // written — by the general rules, until another banner says
          // otherwise.
          flush();
          insideExport = false;
          continue;
        }
        if (startsExportSection(lines, index)) flush();
        current.push(line);
        continue;
      }
      if (thematicBreak.test(line)) {
        flush();
        continue;
      }
      if (headingLine.test(line)) flush();
      current.push(line);
    }
    flush();
    return blocks;
  }

  // Nothing structured anywhere, so no banner either: an export always opens
  // with a heading.
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
  return blocks;
}

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
  const blocks = splitSections(lines);

  let banner: string | undefined;
  const thoughts: ImportedThought[] = [];
  const connections: ImportedConnection[] = [];
  const linesOfThinking: ImportedLine[] = [];
  for (const block of blocks) {
    const section = sectionOf(block.lines);
    let title = section.title;
    let content = section.content;
    if (!title && !content) continue;
    let carried: Partial<ImportedThought> = {};

    if (isExportBanner(content)) {
      // The banner is umm describing the file, not a thought in it. A document
      // may hold several — picking two files makes exactly that — and the
      // first is the one a retry draft is written under.
      banner ??= content.trim();
      continue;
    }

    if (block.inExport) {
      // The connections and the lines of thinking describe the space rather
      // than being thoughts someone had in it.
      if (title === 'Connections' && describesTheSpace(title, content)) {
        // Kept rather than dropped: the thoughts come back without them, and
        // on this canvas what a thought is joined to is half of what it means.
        for (const line of content.split('\n')) {
          const found = exportedConnection.exec(line.trim());
          if (found) {
            const reason = (found[4] ?? '').trim();
            connections.push({ from: found[1], to: found[3], relation: found[2], ...(reason ? { reason } : {}) });
          }
        }
        continue;
      }
      if (title === 'Lines of thinking' && describesTheSpace(title, content)) {
        for (const entry of content.split('\n')) {
          const found = exportedLine.exec(entry.trim());
          if (found) linesOfThinking.push({ name: found[1], status: found[2], resolution: (found[3] ?? '').trim() });
        }
        continue;
      }
      if (describesTheSpace(title, content)) continue;
      const { body, metadata } = splitExportMetadata(content);
      const id = exportedID.exec(metadata)?.[1];
      const canvas = exportedCanvas.exec(metadata);
      const line = exportedLineLabel.exec(metadata)?.[1];
      const kind = exportedKind.exec(metadata)?.[1];
      const color = exportedColor.exec(metadata)?.[1];
      if (id) carried = { sourceId: id };
      if (canvas) carried = { ...carried, x: Number(canvas[1]), y: Number(canvas[2]) };
      if (line) carried = { ...carried, line };
      if (kind) carried = { ...carried, kind };
      if (color) carried = { ...carried, color };
      content = body;
      // A thought that had no title gets one from the exporter; giving it back
      // would name every restored thought "Thought".
      if (title === untitledThought) title = '';
      if (content === '') continue;
    }

    // A heading with nothing under it still carries an idea, so keep the
    // heading itself as the content rather than dropping the section.
    thoughts.push({ title, content: content || title, ...carried });
  }
  return {
    thoughts: thoughts.filter((thought) => thought.content !== ''),
    connections,
    lines: linesOfThinking,
    isExport: banner !== undefined,
    banner,
  };
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

/**
 * Rebuilds a retryable Markdown draft from thoughts that were not imported.
 *
 * When the thoughts came out of an export, the draft is written back as one.
 * Anything else and a retry quietly downgrades what it restores: the draft was
 * plain text, so the second attempt put the thoughts in a fresh grid, in the
 * default colour, as plain thoughts, in no line of thinking — and a large one
 * hit the import cap again, because a draft with no banner is not an export.
 *
 * A connection is only written when both of its ends are being retried. One
 * that reached a thought which imported successfully cannot be restored this
 * way at all: that thought exists now under a new id the draft has no way to
 * name. Rewriting it against the old id would be worse than dropping it, so it
 * is dropped.
 */
export function formatImportedThoughts(
  thoughts: ImportedThought[],
  context?: { banner?: string; connections?: ImportedConnection[]; lines?: ImportedLine[] },
) {
  const plain = () =>
    thoughts
      .map((thought) => {
        if (!thought.title) return thought.content;
        if (thought.content === thought.title) return `# ${thought.title}`;
        return `# ${thought.title}\n\n${thought.content}`;
      })
      .join('\n\n---\n\n');

  if (!context?.banner || !thoughts.some((thought) => thought.sourceId)) return plain();

  const sections = thoughts.map((thought) => {
    const heading = `## ${thought.title || untitledThought}`;
    const metadata: string[] = [];
    if (thought.sourceId) metadata.push(`- id: \`${thought.sourceId}\``);
    if (thought.kind) metadata.push(`- type: \`${thought.kind}\``);
    if (thought.color) metadata.push(`- color: \`${thought.color}\``);
    if (thought.x !== undefined && thought.y !== undefined) metadata.push(`- canvas: \`${thought.x}, ${thought.y}\``);
    if (thought.line) metadata.push(`- line: \`${thought.line}\``);
    const body = [heading, '', thought.content];
    if (metadata.length > 0) body.push('', ...metadata);
    return body.join('\n');
  });

  const retried = new Set(thoughts.map((thought) => thought.sourceId).filter(Boolean));
  const kept = (context.connections ?? []).filter(
    (connection) => retried.has(connection.from) && retried.has(connection.to),
  );
  if (kept.length > 0) {
    sections.push(
      [
        '## Connections',
        '',
        ...kept.map((c) => `- \`${c.from}\` --${c.relation}--> \`${c.to}\`${c.reason ? ` — ${c.reason}` : ''}`),
      ].join('\n'),
    );
  }
  const names = new Set(thoughts.map((thought) => thought.line).filter(Boolean));
  const lines = (context.lines ?? []).filter((line) => names.has(line.name));
  if (lines.length > 0) {
    sections.push(
      [
        '## Lines of thinking',
        '',
        ...lines.map((line) => `- **${line.name}** — ${line.status}${line.resolution ? `: ${line.resolution}` : ''}`),
      ].join('\n'),
    );
  }

  return [context.banner, ...sections].join('\n\n');
}

/** Lays imported thoughts out in a readable grid starting at the given origin. */
export function importLayout(index: number, originX: number, originY: number, columns = 4) {
  return {
    x: originX + (index % columns) * 280,
    y: originY + Math.floor(index / columns) * 200,
  };
}
