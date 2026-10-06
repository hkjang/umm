import { afterEach, describe, expect, it } from 'vitest';
import { downloadFileName } from './download-name';
import { setLocale, translate } from '../i18n/translate';

// The four downloads of one space, in the order the canvas offers them. Each
// entry is what that download passes to `downloadFileName`, so the names in
// this list are the names a reader actually gets.
const fourDownloads = (name: string, outline: string) => [
  downloadFileName(name, 'md'),
  downloadFileName(name, 'md', outline),
  downloadFileName(name, 'png'),
  downloadFileName(name, 'pdf'),
];

// What is left of a produced file name once the parts that are meant to differ
// — the extension and the outline suffix — are taken off. Everything else has
// to be identical across the four, because it comes from one space name.
const baseName = (fileName: string, outline: string) =>
  fileName
    .replace(/^umm-/, '')
    .replace(/\.(md|png|pdf)$/, '')
    .replace(new RegExp(`-${outline}$`), '');

describe('downloadFileName', () => {
  afterEach(() => setLocale('ko'));

  it('gives the four downloads of one space the same base name', () => {
    const outline = translate('차례');

    const bases = fourDownloads('2026/Q4: 기획*안', outline).map((file) => baseName(file, outline));

    expect(bases).toEqual(['2026-Q4- 기획-안', '2026-Q4- 기획-안', '2026-Q4- 기획-안', '2026-Q4- 기획-안']);
  });

  it('replaces every character a file name cannot hold', () => {
    for (const forbidden of ['\\', '/', ':', '*', '?', '"', '<', '>', '|']) {
      expect(downloadFileName(`a${forbidden}b`, 'md')).toBe('umm-a-b.md');
    }
  });

  it('leaves a name that holds no forbidden character exactly as it was', () => {
    expect(downloadFileName('생각 공간', 'md')).toBe('umm-생각 공간.md');
    expect(downloadFileName('My space', 'png')).toBe('umm-My space.png');
    expect(downloadFileName('회고 2026', 'pdf')).toBe('umm-회고 2026.pdf');
  });

  it('puts the suffix between the name and the extension', () => {
    expect(downloadFileName('회고', 'md', '차례')).toBe('umm-회고-차례.md');
    expect(downloadFileName('회고', 'md')).toBe('umm-회고.md');
  });

  it('takes the suffix in the reader language, because the caller translates it', () => {
    setLocale('ko');
    expect(downloadFileName('회고', 'md', translate('차례'))).toBe('umm-회고-차례.md');

    setLocale('en');
    expect(downloadFileName('회고', 'md', translate('차례'))).toBe('umm-회고-outline.md');
  });
});
