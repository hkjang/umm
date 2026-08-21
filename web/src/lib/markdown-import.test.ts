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

  it('caps a very large document', () => {
    const source = Array.from({ length: maxImportedThoughts + 50 }, (_, index) => `# H${index}\nbody`).join('\n');
    expect(splitMarkdownThoughts(source)).toHaveLength(maxImportedThoughts);
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
