import { describe, expect, it } from 'vitest';
import {
  formatImportedThoughts,
  importLayout,
  maxImportedThoughts,
  readMarkdownDocument,
  splitMarkdownThoughts,
} from './markdown-import';

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

- \`f2543505-ca63-49a0-ba05-bd9d1cd37f13\` --related--> \`bfe3a64a-dfc4-4f41-af41-b95afb511003\` — 같은 회고록을 두 번 읽고 이었다
## Lines of thinking

- **되돌리기 실험** — adopted: 되돌아왔습니다
`;

describe("reading umm's own export", () => {
  // The whole of it: three notes went out, three thoughts come back, each
  // holding exactly what the person wrote.
  it('restores the space it was taken from', () => {
    expect(splitMarkdownThoughts(ummExport)).toEqual([
      {
        title: '',
        content: '이어진 생각의 본문',
        sourceId: 'bfe3a64a-dfc4-4f41-af41-b95afb511003',
        x: 0,
        y: 0,
        line: '되돌리기 실험',
        kind: 'thought',
      },
      {
        title: '제목이 있는 생각',
        content: '제목이 있는 생각의 본문',
        sourceId: 'f2543505-ca63-49a0-ba05-bd9d1cd37f13',
        x: 0,
        y: 0,
        kind: 'thought',
      },
      {
        title: '',
        content: '제목이 없는 생각의 본문',
        sourceId: '87e9d59d-a13c-4efb-a252-7ff79ed99993',
        x: 0,
        y: 0,
        kind: 'thought',
      },
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

  // Someone else's Markdown is safe because none of these rules apply to it.
  // Inside umm's own file they all do, and "Connections" is as ordinary a thing
  // to call a thought there as anywhere else — so the heading alone cannot say
  // whether a section is that person's thought or the list the exporter writes
  // at the end. Read as the list, the thought is dropped and its `- id:` never
  // registers, so the connections drawn to it name nothing and go too.
  it('restores a thought titled like one of the export sections', () => {
    const collides = [
      '# 돌아오는 공간',
      '',
      'Exported from umm at 2026-09-10T01:01:26+09:00.',
      '',
      '## Connections',
      '',
      '팀이 어떻게 이어져 있는지 그려 본 것',
      '',
      '- id: `0f1e5f1c-6b9b-4a2f-9d0e-2a7c5b3e8d11`',
      '- type: `thought`',
      '- source: `user`',
      '- canvas: `40, 80`',
      '',
      '## Lines of thinking',
      '',
      '내가 따라가 보려던 방향들',
      '',
      '- id: `7c2d1a90-3f44-4b6e-8a01-5d9e0c4b2f33`',
      '- type: `thought`',
      '- source: `user`',
      '- canvas: `40, 280`',
      '',
      '## Connections',
      '',
      '- `0f1e5f1c-6b9b-4a2f-9d0e-2a7c5b3e8d11` --related--> `7c2d1a90-3f44-4b6e-8a01-5d9e0c4b2f33` — 같은 회의에서 나왔다',
      '',
      '## Lines of thinking',
      '',
      '- **되돌리기 실험** — adopted: 되돌아왔습니다',
    ].join('\n');
    const document = readMarkdownDocument(collides);
    expect(document.isExport).toBe(true);
    // Both thoughts come back, with the titles their author gave them and the
    // ids the connection below names.
    expect(document.thoughts).toEqual([
      {
        title: 'Connections',
        content: '팀이 어떻게 이어져 있는지 그려 본 것',
        sourceId: '0f1e5f1c-6b9b-4a2f-9d0e-2a7c5b3e8d11',
        x: 40,
        y: 80,
        kind: 'thought',
      },
      {
        title: 'Lines of thinking',
        content: '내가 따라가 보려던 방향들',
        sourceId: '7c2d1a90-3f44-4b6e-8a01-5d9e0c4b2f33',
        x: 40,
        y: 280,
        kind: 'thought',
      },
    ]);
    // And the export's own sections are still read as the export's own.
    expect(document.connections).toEqual([
      {
        from: '0f1e5f1c-6b9b-4a2f-9d0e-2a7c5b3e8d11',
        to: '7c2d1a90-3f44-4b6e-8a01-5d9e0c4b2f33',
        relation: 'related',
        reason: '같은 회의에서 나왔다',
      },
    ]);
    expect(document.lines).toEqual([{ name: '되돌리기 실험', status: 'adopted', resolution: '되돌아왔습니다' }]);
  });

  // The tail is what tells them apart, so a thought that carries only some of
  // the metadata — an older export, or one written back as a retry draft — is
  // still a thought.
  it('restores a section-titled thought that carries only its id', () => {
    const sparse = [
      '# 돌아오는 공간',
      '',
      'Exported from umm at 2026-09-10T01:01:26+09:00.',
      '',
      '## Connections',
      '',
      '이건 내 생각입니다',
      '',
      '- id: `0f1e5f1c-6b9b-4a2f-9d0e-2a7c5b3e8d11`',
    ].join('\n');
    expect(splitMarkdownThoughts(sparse)).toEqual([
      { title: 'Connections', content: '이건 내 생각입니다', sourceId: '0f1e5f1c-6b9b-4a2f-9d0e-2a7c5b3e8d11' },
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
      // The whole phrase, timestamp and all, sitting inside a sentence — so
      // what keeps this from being read as a banner is that a banner is the
      // entire body of its section, not that the words are absent.
      'I read Exported from umm at 2026-08-26T16:01:02+09:00. in a file once',
      '',
      '- id: `keep me`',
    ].join('\n');
    const thoughts = splitMarkdownThoughts(mentions);
    expect(thoughts).toHaveLength(2);
    expect(thoughts[1].content).toContain('- id: `keep me`');
  });

  // The import screen appends a chosen file to whatever is already in the box,
  // so an export very often arrives second. A rule that looked for the banner
  // near the top missed exactly this and handed back every id and canvas
  // position it was meant to strip.
  it('reads an export that was appended after something already typed', () => {
    const typedFirst = ['# 오늘 떠오른 것', '', '먼저 적어 둔 생각'].join('\n') + '\n\n---\n\n' + ummExport;
    const restored = splitMarkdownThoughts(typedFirst);
    // What was typed has no history and gains none; what came from the export
    // keeps its own.
    expect(restored[0]).toEqual({ title: '오늘 떠오른 것', content: '먼저 적어 둔 생각' });
    expect(restored.slice(1).map((thought) => [thought.title, thought.content])).toEqual([
      ['', '이어진 생각의 본문'],
      ['제목이 있는 생각', '제목이 있는 생각의 본문'],
      ['', '제목이 없는 생각의 본문'],
    ]);
    expect(restored.slice(1).every((thought) => thought.sourceId !== undefined)).toBe(true);
  });

  // Picking two files joins them with a rule, which is two exports in one
  // document. Both have to be read as exports, not just the first.
  it('reads two exports picked at once', () => {
    const both = [ummExport, ummExport].join('\n\n---\n\n');
    const thoughts = splitMarkdownThoughts(both);
    expect(thoughts).toHaveLength(6);
    expect(thoughts.map((thought) => thought.content)).toEqual([
      '이어진 생각의 본문',
      '제목이 있는 생각의 본문',
      '제목이 없는 생각의 본문',
      '이어진 생각의 본문',
      '제목이 있는 생각의 본문',
      '제목이 없는 생각의 본문',
    ]);
  });

  // An export of an empty space is a banner and nothing else, and importing it
  // must add nothing rather than adding the banner.
  it('imports nothing from an export with no thoughts in it', () => {
    expect(splitMarkdownThoughts('# 빈 공간\n\nExported from umm at 2026-08-26T16:01:02+09:00.\n')).toEqual([]);
  });
});

// A thought whose own words look like the file's structure.
//
// The general rules cut at every heading and every horizontal rule, which is
// how people separate ideas when they write Markdown by hand. Inside an export
// those marks are usually part of what somebody pasted into a thought, and
// cutting there broke one thought into several — of which only the last kept
// the metadata list, so the rest came back with no id, no position and no
// colour, and every connection drawn to them could not be redrawn.
describe('a thought in an export that is written in Markdown itself', () => {
  const withStructure = (body: string) =>
    [
      '# 돌아오는 공간',
      '',
      'Exported from umm at 2026-08-26T16:01:02+09:00.',
      '',
      '## 붙여 넣은 생각',
      '',
      body,
      '',
      '- id: `f2543505-ca63-49a0-ba05-bd9d1cd37f13`',
      '- type: `question`',
      '- source: `user`',
      '- color: `blue`',
      '- canvas: `120, 240`',
      '',
    ].join('\n');

  it('comes back whole when its body holds a heading', () => {
    expect(splitMarkdownThoughts(withStructure('### 배경\n\n왜 이 결정을 했는지'))).toEqual([
      {
        title: '붙여 넣은 생각',
        content: '### 배경\n\n왜 이 결정을 했는지',
        sourceId: 'f2543505-ca63-49a0-ba05-bd9d1cd37f13',
        x: 120,
        y: 240,
        kind: 'question',
        color: 'blue',
      },
    ]);
  });

  it('comes back whole when its body holds a horizontal rule', () => {
    const restored = splitMarkdownThoughts(withStructure('앞의 절반\n\n---\n\n뒤의 절반'));
    expect(restored).toHaveLength(1);
    expect(restored[0].content).toBe('앞의 절반\n\n---\n\n뒤의 절반');
    expect(restored[0].sourceId).toBe('f2543505-ca63-49a0-ba05-bd9d1cd37f13');
  });

  // The metadata list is read on its own rather than searched for in the whole
  // section. Searching found this line first, so the thought came back under a
  // name nothing in the restored space answered to.
  it('does not take an id out of its body', () => {
    const restored = splitMarkdownThoughts(withStructure('- id: `ours-2024-11`\n- 담당: 우리 팀'));
    expect(restored[0].sourceId).toBe('f2543505-ca63-49a0-ba05-bd9d1cd37f13');
    expect(restored[0].content).toBe('- id: `ours-2024-11`\n- 담당: 우리 팀');
  });

  // Two exports joined by the import screen's rule. The rule no longer cuts
  // inside a thought, so the seam has to be told from a rule in a body by the
  // line before it: metadata means the first file has finished.
  it('still tells two exports apart when the last thought of the first has none', () => {
    const plain = [
      '# 앞의 공간',
      '',
      'Exported from umm at 2026-08-26T16:01:02+09:00.',
      '',
      '## 앞의 생각',
      '',
      '앞의 본문',
      '',
      '- id: `bfe3a64a-dfc4-4f41-af41-b95afb511003`',
      '',
    ].join('\n');
    const restored = splitMarkdownThoughts([plain, withStructure('뒤의 본문')].join('\n\n---\n\n'));
    expect(restored.map((thought) => [thought.title, thought.content])).toEqual([
      ['앞의 생각', '앞의 본문'],
      ['붙여 넣은 생각', '뒤의 본문'],
    ]);
    expect(restored[0].sourceId).toBe('bfe3a64a-dfc4-4f41-af41-b95afb511003');
  });
});

// An export followed by somebody's ordinary notes.
//
// The import screen joins whatever is picked with a rule, and an export picked
// alongside a plain file lands in front of it about half the time. Reading
// everything after the banner by the exporter's rules swallowed the plain
// file: its headings stopped cutting, its rule stopped cutting, and the whole
// of it — rule, headings and all — was carried into the body of the export's
// last thought, on top of that thought's own metadata list. Three notes
// collapsed into one wall of text and the export's thought lost its id.
describe('an export with ordinary Markdown appended after it', () => {
  const exported = [
    '# 공간',
    '',
    'Exported from umm at 2026-09-10T16:07:17+09:00.',
    '',
    '## 첫 생각',
    '',
    '본문',
    '',
    '- id: `aaaa`',
    '- canvas: `10, 20`',
    '',
  ].join('\n');
  const notes = ['# 노트 A', '', '가', '', '# 노트 B', '', '나', '', '# 노트 C', '', '다'].join('\n');

  it('reads the plain file by the general rules again', () => {
    const document = readMarkdownDocument([exported, notes].join('\n\n---\n\n'));
    expect(document.isExport).toBe(true);
    expect(document.thoughts).toEqual([
      { title: '첫 생각', content: '본문', sourceId: 'aaaa', x: 10, y: 20 },
      { title: '노트 A', content: '가' },
      { title: '노트 B', content: '나' },
      { title: '노트 C', content: '다' },
    ]);
  });

  // The plain file may use the export's own words, and past the seam none of
  // them mean anything: a note called Connections is a note.
  it('does not read the plain file as part of the export', () => {
    const mine = [
      '# Connections',
      '',
      '- 이건 목록이지 연결이 아님',
      '',
      '---',
      '',
      '## Thought',
      '',
      '내가 그렇게 부른 생각',
    ].join('\n');
    const document = readMarkdownDocument([exported, mine].join('\n\n---\n\n'));
    expect(document.connections).toEqual([]);
    expect(document.thoughts.slice(1)).toEqual([
      { title: 'Connections', content: '- 이건 목록이지 연결이 아님' },
      { title: 'Thought', content: '내가 그렇게 부른 생각' },
    ]);
  });

  // The seam is found after the closing sections too, not only after a thought.
  it('finds the seam after the connections and the lines of thinking', () => {
    const thoughts = splitMarkdownThoughts([ummExport, notes].join('\n\n---\n\n'));
    expect(thoughts.map((thought) => thought.title)).toEqual([
      '',
      '제목이 있는 생각',
      '',
      '노트 A',
      '노트 B',
      '노트 C',
    ]);
    expect(thoughts.slice(0, 3).every((thought) => thought.sourceId !== undefined)).toBe(true);
    expect(thoughts.slice(3).every((thought) => thought.sourceId === undefined)).toBe(true);
  });

  // And in the other order — typed first, then an export, then plain notes —
  // each part is read by its own rules.
  it('reads typed text, an export and a plain file each by their own rules', () => {
    const typed = ['# 먼저 적은 것', '', '한 줄'].join('\n');
    const thoughts = splitMarkdownThoughts([typed, exported, notes].join('\n\n---\n\n'));
    expect(thoughts.map((thought) => [thought.title, thought.sourceId])).toEqual([
      ['먼저 적은 것', undefined],
      ['첫 생각', 'aaaa'],
      ['노트 A', undefined],
      ['노트 B', undefined],
      ['노트 C', undefined],
    ]);
  });
});

describe('restoring a space rather than a list of sentences', () => {
  // Where a thought sits is part of what it says on this canvas, so an export
  // that comes back in a fresh grid has lost something people built by hand.
  it('brings each thought back to where it was', () => {
    const { thoughts } = readMarkdownDocument(ummExport);
    expect(thoughts.map((thought) => [thought.x, thought.y])).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
  });

  it('remembers what each thought used to be called', () => {
    const { thoughts } = readMarkdownDocument(ummExport);
    expect(thoughts.map((thought) => thought.sourceId)).toEqual([
      'bfe3a64a-dfc4-4f41-af41-b95afb511003',
      'f2543505-ca63-49a0-ba05-bd9d1cd37f13',
      '87e9d59d-a13c-4efb-a252-7ff79ed99993',
    ]);
  });

  // The connections were being read as a section to skip. They are the other
  // half of what a space is.
  it('reads the connections between them', () => {
    expect(readMarkdownDocument(ummExport).connections).toEqual([
      {
        from: 'f2543505-ca63-49a0-ba05-bd9d1cd37f13',
        to: 'bfe3a64a-dfc4-4f41-af41-b95afb511003',
        relation: 'related',
        reason: '같은 회고록을 두 번 읽고 이었다',
      },
    ]);
  });

  // The why is the half of a connection that disappears first from anybody's
  // memory. A restore that brought the line back and left the reason in the
  // file would return the part that can be reconstructed and lose the part
  // that cannot.
  it('brings back why a connection was drawn', () => {
    const { connections } = readMarkdownDocument(ummExport);
    expect(connections[0].reason).toBe('같은 회고록을 두 번 읽고 이었다');
  });

  // The origin says who made the connection, and a file may not claim it — the
  // same rule the API enforces on a request body. It is read past, not into
  // the reason.
  it('reads past the origin without mistaking it for a reason', () => {
    const withOrigin = ummExport.replace(
      '--related--> `bfe3a64a-dfc4-4f41-af41-b95afb511003` —',
      '--related--> `bfe3a64a-dfc4-4f41-af41-b95afb511003` (auto) —',
    );
    const { connections } = readMarkdownDocument(withOrigin);
    expect(connections[0].reason).toBe('같은 회고록을 두 번 읽고 이었다');
    expect(connections[0]).not.toHaveProperty('origin');
  });

  // Most connections have no reason, and an empty one must not come back as a
  // reason made of nothing.
  it('carries no reason for a connection nobody explained', () => {
    const plain = ummExport.replace(' — 같은 회고록을 두 번 읽고 이었다', '');
    const { connections } = readMarkdownDocument(plain);
    expect(connections[0].reason).toBeUndefined();
  });

  // The ids in the Connections section have to be ids the thoughts actually
  // carry, or nothing can be joined back up.
  it('names connections by ids the thoughts carry', () => {
    const { thoughts, connections } = readMarkdownDocument(ummExport);
    const ids = new Set(thoughts.map((thought) => thought.sourceId));
    for (const connection of connections) {
      expect(ids.has(connection.from)).toBe(true);
      expect(ids.has(connection.to)).toBe(true);
    }
  });

  // Someone else's Markdown has no history, and inventing one would put their
  // thoughts at coordinates they never chose.
  it('carries nothing for a document that is not an export', () => {
    const { thoughts, connections } = readMarkdownDocument('# One\n\nbody\n\n## Two\n\nmore');
    expect(connections).toEqual([]);
    for (const thought of thoughts) {
      expect(thought.sourceId).toBeUndefined();
      expect(thought.x).toBeUndefined();
      expect(thought.y).toBeUndefined();
    }
  });

  it('reads the connections of both exports when two are picked at once', () => {
    const both = [ummExport, ummExport].join('\n\n---\n\n');
    expect(readMarkdownDocument(both).connections).toHaveLength(2);
  });

  it('still answers the thoughts-only question the same way', () => {
    expect(splitMarkdownThoughts(ummExport).map((thought) => thought.content)).toEqual(
      readMarkdownDocument(ummExport).thoughts.map((thought) => thought.content),
    );
  });
});

describe('the lines of thinking in an export', () => {
  // The status and the reason are the half people lose first: a thought that
  // was tried and set aside reads exactly like a current one once the label is
  // gone.
  it('reads each line with how it ended and why', () => {
    expect(readMarkdownDocument(ummExport).lines).toEqual([
      { name: '되돌리기 실험', status: 'adopted', resolution: '되돌아왔습니다' },
    ]);
  });

  it('says which line each thought belonged to, and leaves the others alone', () => {
    const { thoughts } = readMarkdownDocument(ummExport);
    expect(thoughts.map((thought) => thought.line)).toEqual(['되돌리기 실험', undefined, undefined]);
  });

  // A line still being followed has no resolution to write, and reading one in
  // would invent a reason nobody gave.
  it('reads a line that has not ended yet', () => {
    const open = ummExport.replace('- **되돌리기 실험** — adopted: 되돌아왔습니다', '- **아직 가는 중** — open');
    expect(readMarkdownDocument(open).lines).toEqual([{ name: '아직 가는 중', status: 'open', resolution: '' }]);
  });

  // The export has always written the kind and the importer has always thrown
  // it away, so every restored question came back a plain thought.
  it('says what sort of thought each one was', () => {
    expect(readMarkdownDocument(ummExport).thoughts.map((thought) => thought.kind)).toEqual([
      'thought',
      'thought',
      'thought',
    ]);
    const asked = ummExport.replace('- type: `thought`', '- type: `question`');
    expect(readMarkdownDocument(asked).thoughts[0].kind).toBe('question');
  });

  // Colour is a choice on a colour-coded canvas, not decoration.
  it('says what colour each one was', () => {
    const blue = ummExport.replace(
      '- source: `user`\n- canvas: `0, 0`\n- line:',
      '- source: `user`\n- color: `blue`\n- canvas: `0, 0`\n- line:',
    );
    const read = readMarkdownDocument(blue).thoughts;
    expect(read[0].color).toBe('blue');
    expect(read[1].color).toBeUndefined();
    // And the colour line does not survive into the body.
    expect(read[0].content).toBe('이어진 생각의 본문');
  });

  it('carries no lines for a document that is not an export', () => {
    expect(readMarkdownDocument('# One\n\n- **not a line** — open').lines).toEqual([]);
  });
});

describe("telling umm's own file apart", () => {
  it("says so for an export and not for anyone else's Markdown", () => {
    expect(readMarkdownDocument(ummExport).isExport).toBe(true);
    expect(readMarkdownDocument('# One\n\nbody\n\n## Two\n\nmore').isExport).toBe(false);
  });

  // The piece of a split export that does not carry the banner is not an
  // export as far as the reader is concerned, which is exactly why splitting
  // one is the wrong advice to give anybody.
  it('does not claim a piece cut out of an export is one', () => {
    const cut = ummExport.slice(ummExport.indexOf('## 제목이 있는 생각'));
    expect(readMarkdownDocument(cut).isExport).toBe(false);
  });
});

describe('retrying what did not import', () => {
  // The draft used to be plain text, so a second attempt put the thoughts in a
  // fresh grid, in the default colour, as plain thoughts, in no line — and a
  // large one hit the cap again, because a draft with no banner is not an
  // export. Making a whole space importable made partial failure likely enough
  // that this stopped being theoretical.
  it('writes a failed export back as an export', () => {
    const doc = readMarkdownDocument(ummExport);
    const draft = formatImportedThoughts(doc.thoughts.slice(0, 2), {
      banner: doc.banner,
      connections: doc.connections,
      lines: doc.lines,
    });
    const again = readMarkdownDocument(draft);
    expect(again.isExport).toBe(true);
    expect(again.thoughts).toEqual(doc.thoughts.slice(0, 2));
    expect(again.connections).toEqual(doc.connections);
    expect(again.lines).toEqual(doc.lines);
  });

  // A connection reaching a thought that imported successfully cannot be
  // restored by retrying: that thought exists now under a new id the draft has
  // no way to name. Writing it against the old id would be worse than dropping
  // it.
  it('drops a connection whose other end is not being retried', () => {
    const doc = readMarkdownDocument(ummExport);
    const draft = formatImportedThoughts([doc.thoughts[0]], {
      banner: doc.banner,
      connections: doc.connections,
      lines: doc.lines,
    });
    expect(readMarkdownDocument(draft).connections).toEqual([]);
    // The thought itself still comes back whole.
    expect(readMarkdownDocument(draft).thoughts).toEqual([doc.thoughts[0]]);
  });

  it('keeps only the lines the retried thoughts belonged to', () => {
    const doc = readMarkdownDocument(ummExport);
    const draft = formatImportedThoughts([doc.thoughts[1]], { banner: doc.banner, lines: doc.lines });
    expect(readMarkdownDocument(draft).lines).toEqual([]);
  });

  // Someone else's Markdown has no banner and no history, and inventing one
  // would claim a provenance the text does not have.
  it('leaves an ordinary draft plain', () => {
    const thoughts = [
      { title: 'One', content: 'body' },
      { title: '', content: 'loose' },
    ];
    expect(formatImportedThoughts(thoughts)).toBe('# One\n\nbody\n\n---\n\nloose');
    expect(readMarkdownDocument(formatImportedThoughts(thoughts)).isExport).toBe(false);
  });
});
