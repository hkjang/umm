import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getLocale, isLocale, msg, setLocale, subscribeToLocale, translate } from './translate';

describe('translate', () => {
  beforeEach(() => setLocale('ko'));

  it('returns the Korean source when the active language is Korean', () => {
    expect(translate('오늘의 리뷰')).toBe('오늘의 리뷰');
  });

  it('looks a string up by its Korean source once the language changes', () => {
    setLocale('en');
    expect(translate('오늘의 리뷰')).toBe('Today’s review');
  });

  // A missing translation must never surface a key or an empty string: the
  // Korean original is always a correct thing to render.
  it('falls back to the source text for an untranslated string', () => {
    setLocale('en');
    expect(translate('사전에 없는 문장입니다')).toBe('사전에 없는 문장입니다');
  });

  it('interpolates named parameters in both languages', () => {
    expect(translate('알림 {count}개', { count: 3 })).toBe('알림 3개');
    setLocale('en');
    expect(translate('알림 {count}개', { count: 3 })).toBe('3 notifications');
  });

  it('leaves a placeholder alone when no value is supplied', () => {
    expect(translate('알림 {count}개', {})).toBe('알림 {count}개');
  });

  it('notifies subscribers and updates the document language', () => {
    const seen: string[] = [];
    const unsubscribe = subscribeToLocale((locale) => seen.push(locale));
    setLocale('en');
    setLocale('en'); // A repeat is not a change and must not notify again.
    setLocale('ko');
    unsubscribe();
    setLocale('en');
    expect(seen).toEqual(['en', 'ko']);
    expect(getLocale()).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('recognises supported locales only', () => {
    expect(isLocale('ko')).toBe(true);
    expect(isLocale('en')).toBe(true);
    expect(isLocale('fr')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });

  it('msg is an identity marker for lookup tables', () => {
    expect(msg('오늘의 리뷰')).toBe('오늘의 리뷰');
  });
});

describe('resolveInitialLocale', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('prefers a stored choice', async () => {
    localStorage.setItem('umm:locale', 'en');
    const { resolveInitialLocale } = await import('./index');
    expect(resolveInitialLocale()).toBe('en');
  });

  it('falls back to the browser languages, then Korean', async () => {
    const { resolveInitialLocale } = await import('./index');
    vi.stubGlobal('navigator', { languages: ['en-GB', 'ko'] });
    expect(resolveInitialLocale()).toBe('en');
    vi.stubGlobal('navigator', { languages: ['fr-FR'] });
    expect(resolveInitialLocale()).toBe('ko');
  });
});
