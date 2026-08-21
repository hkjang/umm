import { en } from './en';

export type Locale = 'ko' | 'en';

export const locales: readonly Locale[] = ['ko', 'en'] as const;

export const localeLabels: Record<Locale, string> = { ko: '한국어', en: 'English' };

export type Dictionary = Readonly<Record<string, string>>;

export type TranslateParams = Record<string, string | number>;

/**
 * Translations are keyed by their Korean source text.
 *
 * Korean therefore needs no dictionary at all and can never regress, and a
 * missing translation degrades to the original wording instead of showing a
 * raw key. Adding a language means adding a dictionary; adding a string means
 * writing it in Korean as before and wrapping it in `t(...)`.
 */
const dictionaries = new Map<Locale, Dictionary>();

export function registerDictionary(locale: Locale, dictionary: Dictionary) {
  dictionaries.set(locale, dictionary);
}

// Registering here rather than in the React entry point means any module that
// can translate — including the API client, which runs outside React — always
// has the dictionaries loaded, in the app and in tests alike. The import of
// `en` is value-only in one direction: en.ts imports only a type from here, so
// there is no runtime cycle.
registerDictionary('en', en);

let activeLocale: Locale = 'ko';
const listeners = new Set<(locale: Locale) => void>();

export const getLocale = (): Locale => activeLocale;

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (locales as readonly string[]).includes(value);
}

export function setLocale(locale: Locale) {
  if (locale === activeLocale) return;
  activeLocale = locale;
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
  listeners.forEach((listener) => listener(locale));
}

export function subscribeToLocale(listener: (locale: Locale) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const interpolate = (template: string, params?: TranslateParams) =>
  params
    ? template.replaceAll(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    : template;

/**
 * translate is the locale-aware lookup for code that runs outside React, such
 * as the API client. Components should prefer the `t` from `useTranslation`,
 * which also re-renders when the language changes.
 */
export function translate(source: string, params?: TranslateParams): string {
  const dictionary = dictionaries.get(activeLocale);
  return interpolate(dictionary?.[source] ?? source, params);
}

/**
 * msg marks a Korean literal as a translation key without translating it yet.
 *
 * Lookup tables — menu definitions, enum labels, problem titles — declare their
 * copy far from where it is rendered. Wrapping those literals tells the i18n
 * coverage check that the string is a key, and keeps it findable when the
 * dictionary is updated.
 */
export const msg = (source: string): string => source;

/** Intl tag for the active locale, used for dates, times and numbers. */
export const intlLocale = (): string => (activeLocale === 'ko' ? 'ko-KR' : 'en-US');
