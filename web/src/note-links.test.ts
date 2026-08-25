import { describe, expect, it } from 'vitest';
import { maxNoteLinks, noteLinks } from './note-links';

describe('noteLinks', () => {
  it('finds nothing in a thought that refers to nothing', () => {
    expect(noteLinks('회고 주기를 격주로 줄여 보자')).toEqual([]);
    expect(noteLinks('')).toEqual([]);
  });

  it('finds an address in the middle of a sentence', () => {
    const links = noteLinks('참고 자료: https://github.com/hkjang/umm 를 보면 된다');
    expect(links.map((l) => l.href)).toEqual(['https://github.com/hkjang/umm']);
  });

  // A full stop after a URL ends the sentence; it is not part of the address.
  it('leaves sentence punctuation out of the address', () => {
    for (const [text, want] of [
      ['자세한 건 https://example.com/문서 에.', 'https://example.com/문서'],
      ['https://example.com/a,', 'https://example.com/a'],
      ['(https://example.com/b)', 'https://example.com/b'],
      ['https://example.com/c…', 'https://example.com/c'],
    ] as const) {
      expect(noteLinks(text)[0]?.href).toBe(want);
    }
  });

  it('keeps the order they were written in', () => {
    const links = noteLinks('먼저 https://a.example/1 그다음 https://b.example/2');
    expect(links.map((l) => l.href)).toEqual(['https://a.example/1', 'https://b.example/2']);
  });

  it('lists the same address once', () => {
    const links = noteLinks('https://a.example/x 와 https://a.example/x 는 같다');
    expect(links).toHaveLength(1);
  });

  // A note may contain anything. Turning arbitrary text into something openable
  // is how a "link" ends up being javascript: or file:.
  it('opens nothing that is not http or https', () => {
    for (const text of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<script>alert(1)</script>',
      'ftp://example.com/x',
      'mailto:someone@example.com',
      'vbscript:msgbox(1)',
    ]) {
      expect(noteLinks(text)).toEqual([]);
    }
  });

  // Something can begin with the right characters and still not be an address.
  it('ignores text that only looks like an address', () => {
    expect(noteLinks('https://')).toEqual([]);
    expect(noteLinks('http:// 공백이 있다')).toEqual([]);
  });

  it('stops before a note of links becomes a list of its own', () => {
    const many = Array.from({ length: maxNoteLinks + 6 }, (_, i) => `https://example.com/${i}`).join(' ');
    expect(noteLinks(many)).toHaveLength(maxNoteLinks);
  });

  describe('labels', () => {
    it('is the host when there is no path to tell pages apart', () => {
      expect(noteLinks('https://www.example.com/')[0].label).toBe('example.com');
      expect(noteLinks('https://example.com')[0].label).toBe('example.com');
    });

    it('carries enough path to tell two pages of a site apart', () => {
      const [a, b] = noteLinks('https://github.com/hkjang/umm https://github.com/hkjang/ptium');
      expect(a.label).not.toBe(b.label);
      expect(a.label).toContain('umm');
      expect(b.label).toContain('ptium');
    });

    // Trimmed from the front, because the end of a path says which page it is.
    it('keeps the end of a long path rather than the start', () => {
      const [link] = noteLinks('https://example.com/a/very/long/path/that/goes/on/and/on/final-page');
      expect(link.label.length).toBeLessThanOrEqual(42);
      expect(link.label).toContain('final-page');
      expect(link.label).toContain('example.com');
    });
  });
});
