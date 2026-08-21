export interface ImportedThought {
  title: string;
  content: string;
}

export interface ImportThoughtsResult {
  created: number;
  failed: ImportedThought[];
}

/** Bounds one import so a large vault cannot flood a canvas in a single click. */
export const maxImportedThoughts = 200;

const headingLine = /^#{1,6}\s+\S/;
const thematicBreak = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

/**
 * splitMarkdownThoughts turns a Markdown document into one thought per section.
 *
 * Sections are cut at headings and thematic breaks, which is how people already
 * separate ideas in a note file. A document with neither falls back to blank
 * line separated blocks, so a plain list of paragraphs still imports as
 * separate thoughts instead of one wall of text.
 */
export function splitMarkdownThoughts(source: string): ImportedThought[] {
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

  const thoughts: ImportedThought[] = [];
  for (const block of blocks) {
    const body = block.join('\n').trim();
    if (!body) continue;
    const [first, ...rest] = body.split('\n');
    const title = headingLine.test(first) ? first.replace(/^#{1,6}\s+/, '').trim() : '';
    const content = title ? rest.join('\n').trim() : body;
    // A heading with nothing under it still carries an idea, so keep the
    // heading itself as the content rather than dropping the section.
    thoughts.push({ title, content: content || title });
  }
  return thoughts.filter((thought) => thought.content !== '');
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
