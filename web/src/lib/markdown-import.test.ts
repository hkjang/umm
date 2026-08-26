import { describe, expect, it } from 'vitest';
import { formatImportedThoughts, importLayout, maxImportedThoughts, splitMarkdownThoughts } from './markdown-import';

describe('splitMarkdownThoughts', () => {
  it('cuts a document at its headings and keeps them as titles', () => {
    const thoughts = splitMarkdownThoughts('# First\nbody one\n\n## Second\nbody two');
    expect(thoughts).toEqual([
      { title: 'First', content: 'body one' },
      { title: 'Second', content: 'body two' },
    ]);
  });

  it('cuts at thematic breaks', () => {
    const thoughts = splitMarkdownThoughts('one\n---\ntwo\n***\nthree');
    expect(thoughts.map((thought) => thought.content)).toEqual(['one', 'two', 'three']);
  });

  it('leaves headings inside fenced code alone', () => {
    const thoughts = splitMarkdownThoughts('# Title\n```\n# not a heading\n```\ntail');
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0].content).toContain('# not a heading');
  });

  it('falls back to blank line blocks when there is no structure', () => {
    const thoughts = splitMarkdownThoughts('first idea\n\nsecond idea\n\n\nthird idea');
    expect(thoughts.map((thought) => thought.content)).toEqual(['first idea', 'second idea', 'third idea']);
  });

  it('keeps a heading that has no body', () => {
    expect(splitMarkdownThoughts('# Lonely')).toEqual([{ title: 'Lonely', content: 'Lonely' }]);
  });

  it('ignores empty input and whitespace', () => {
    expect(splitMarkdownThoughts('')).toEqual([]);
    expect(splitMarkdownThoughts('   \n\n  \n')).toEqual([]);
  });

  it('reports every section so the importer can reject an oversized draft without losing its tail', () => {
    const source = Array.from({ length: maxImportedThoughts + 50 }, (_, index) => `# H${index}\nbody`).join('\n');
    const thoughts = splitMarkdownThoughts(source);
    expect(thoughts).toHaveLength(maxImportedThoughts + 50);
    expect(thoughts.at(-1)).toEqual({ title: `H${maxImportedThoughts + 49}`, content: 'body' });
  });

  it('handles CRLF line endings', () => {
    expect(splitMarkdownThoughts('# A\r\nbody\r\n\r\n# B\r\nbody')).toHaveLength(2);
  });

  it('round-trips failed thoughts into a retryable draft', () => {
    const failed = [
      { title: 'First', content: 'body one' },
      { title: '', content: 'plain thought' },
      { title: 'Heading only', content: 'Heading only' },
    ];
    expect(splitMarkdownThoughts(formatImportedThoughts(failed))).toEqual(failed);
  });
});

describe('importLayout', () => {
  it('fills a grid row by row', () => {
    expect(importLayout(0, 100, 200)).toEqual({ x: 100, y: 200 });
    expect(importLayout(3, 100, 200)).toEqual({ x: 100 + 3 * 280, y: 200 });
    expect(importLayout(4, 100, 200)).toEqual({ x: 100, y: 200 + 200 });
  });
});

// Reading umm's own export back in.
//
// The exporter and the importer are both umm's, and until this fixture existed
// they had never been run against each other. Exporting a space and importing
// it back produced one extra thought from the banner, carried the id/type/
// canvas list into every body, and named every untitled thought "Thought".
//
// This is real output from the exporter, captured from
// TestMarkdownExportKeepsTheShapeTheImporterReadsIntegration, which asserts the
// other side of the same agreement: that the exporter still writes these
// markers.
const ummExport = `# 돌아오는 공간

Exported from umm at 2026-08-26T16:01:02+09:00.

## Thought

이어진 생각의 본문

- id: \`bfe3a64a-dfc4-4f41-af41-b95afb511003\`
- type: \`thought\`
- source: \`user\`
- canvas: \`0, 0\`
- line: \`되돌리기 실험\` (adopted)

## 제목이 있는 생각

제목이 있는 생각의 본문

- id: \`f2543505-ca63-49a0-ba05-bd9d1cd37f13\`
- type: \`thought\`
- source: \`user\`
- canvas: \`0, 0\`

## Thought

제목이 없는 생각의 본문

- id: \`87e9d59d-a13c-4efb-a252-7ff79ed99993\`
- type: \`thought\`
- source: \`user\`
- canvas: \`0, 0\`

## Connections

- \`f2543505-ca63-49a0-ba05-bd9d1cd37f13\` --related--> \`bfe3a64a-dfc4-4f41-af41-b95afb511003\`
## Lines of thinking

- **되돌리기 실험** — adopted: 되돌아왔습니다
`;

describe("reading umm's own export", () => {
  // The whole of it: three notes went out, three thoughts come back, each
  // holding exactly what the person wrote.
  it('restores the space it was taken from', () => {
    expect(splitMarkdownThoughts(ummExport)).toEqual([
      { title: '', content: '이어진 생각의 본문' },
      { title: '제목이 있는 생각', content: '제목이 있는 생각의 본문' },
      { title: '', content: '제목이 없는 생각의 본문' },
    ]);
  });

  it('does not turn the export banner into a thought', () => {
    const thoughts = splitMarkdownThoughts(ummExport);
    expect(thoughts.some((thought) => thought.content.includes('Exported from umm'))).toBe(false);
    expect(thoughts.some((thought) => thought.title === '돌아오는 공간')).toBe(false);
  });

  it('leaves the id, type, source, canvas and line out of the body', () => {
    for (const thought of splitMarkdownThoughts(ummExport)) {
      expect(thought.content).not.toMatch(/^-\s+(id|type|source|canvas|line):/m);
    }
  });

  // These sections describe the space rather than being thoughts in it, and
  // importing them would put "Connections" on the canvas as a note.
  it('does not import the connections or the lines of thinking as thoughts', () => {
    const titles = splitMarkdownThoughts(ummExport).map((thought) => thought.title);
    expect(titles).not.toContain('Connections');
    expect(titles).not.toContain('Lines of thinking');
  });

  // "Thought" is the word the exporter writes where a note had no title. Giving
  // it back would name every restored thought the same thing.
  it('restores an untitled thought without a title', () => {
    const restored = splitMarkdownThoughts(ummExport);
    expect(restored[0].title).toBe('');
    expect(restored[2].title).toBe('');
    expect(restored[1].title).toBe('제목이 있는 생각');
  });

  // The rules above are umm's file being read as umm's file. Someone else's
  // notes may use all the same words, and none of it may apply to them.
  it('reads an ordinary document exactly as before', () => {
    const mine = [
      '# Connections',
      '',
      'how the parts fit together',
      '',
      '## Thought',
      '',
      'a thought I titled Thought on purpose',
      '',
      '- id: `my own numbering`',
      '',
      '## Lines of thinking',
      '',
      'what I am following up',
    ].join('\n');
    expect(splitMarkdownThoughts(mine)).toEqual([
      { title: 'Connections', content: 'how the parts fit together' },
      { title: 'Thought', content: 'a thought I titled Thought on purpose\n\n- id: `my own numbering`' },
      { title: 'Lines of thinking', content: 'what I am following up' },
    ]);
  });

  // The banner is only the banner where the exporter puts it, directly under
  // the space name. Further down it is something someone wrote about umm.
  it('does not mistake a document that mentions the phrase for an export', () => {
    const mentions = [
      '# My notes',
      '',
      'first idea',
      '',
      '## Later',
      '',
      'I read "Exported from umm at" in a file once',
      '',
      '- id: `keep me`',
    ].join('\n');
    const thoughts = splitMarkdownThoughts(mentions);
    expect(thoughts).toHaveLength(2);
    expect(thoughts[1].content).toContain('- id: `keep me`');
  });

  // An export of an empty space is a banner and nothing else, and importing it
  // must add nothing rather than adding the banner.
  it('imports nothing from an export with no thoughts in it', () => {
    expect(splitMarkdownThoughts('# 빈 공간\n\nExported from umm at 2026-08-26T16:01:02+09:00.\n')).toEqual([]);
  });
});
