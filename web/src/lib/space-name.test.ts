import { afterEach, describe, expect, it } from 'vitest';
import { spaceDisplayName } from './space-name';
import type { Space } from '../api';
import { setLocale, translate } from '../i18n/translate';

const space = (id: string, name: string): Space => ({
  id,
  ownerId: 'owner-1',
  name,
  color: 'grape',
  aiExcluded: false,
  isInbox: false,
});

describe('spaceDisplayName', () => {
  it('shows the name the owner gave the space', () => {
    const spaces = [space('a', '회고'), space('b', '제품 계획')];

    expect(spaceDisplayName(spaces, 'b', '내 공간')).toBe('제품 계획');
  });

  it('falls back when the name is empty', () => {
    expect(spaceDisplayName([space('a', '')], 'a', '내 공간')).toBe('내 공간');
  });

  it('falls back when the name is only whitespace, which no heading or file name can show', () => {
    expect(spaceDisplayName([space('a', '   ')], 'a', '내 공간')).toBe('내 공간');
  });

  it('falls back when the active space is not in the list yet', () => {
    expect(spaceDisplayName([space('a', '회고')], 'zzz', '내 공간')).toBe('내 공간');
    expect(spaceDisplayName([], undefined, '내 공간')).toBe('내 공간');
  });

  it('leaves a name that happens to be a dictionary key alone', () => {
    // '생각 공간' is a key in the English dictionary. It is this person's
    // wording for their space, so it must survive the English locale intact.
    setLocale('en');

    expect(spaceDisplayName([space('a', '생각 공간')], 'a', translate('내 공간'))).toBe('생각 공간');
  });
});

describe('the fallback the canvas passes in', () => {
  afterEach(() => setLocale('ko'));

  it('reads as Korean for a Korean reader', () => {
    setLocale('ko');

    expect(translate('내 공간')).toBe('내 공간');
  });

  it('reads as English for an English reader', () => {
    setLocale('en');

    expect(translate('내 공간')).toBe('My space');
  });
});
