import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  getLocale,
  intlLocale,
  isLocale,
  setLocale,
  subscribeToLocale,
  translate,
  type Locale,
  type TranslateParams,
} from './translate';
import { readLocalStorage, writeLocalStorage } from '../lib/browser-storage';

export { locales, localeLabels, isLocale, msg, translate, intlLocale, type Locale } from './translate';

const storageKey = 'umm:locale';

/**
 * resolveInitialLocale prefers an explicit past choice, then the browser's
 * languages, and falls back to Korean — the language umm is authored in.
 */
export function resolveInitialLocale(): Locale {
  const stored = readLocalStorage(storageKey);
  if (stored.available && isLocale(stored.value)) return stored.value;
  const preferred = typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language]);
  for (const tag of preferred) {
    const base = tag?.split('-')[0];
    if (isLocale(base)) return base;
  }
  return 'ko';
}

interface TranslationContextValue {
  locale: Locale;
  t: (source: string, params?: TranslateParams) => string;
  changeLocale: (locale: Locale) => void;
  formatDate: (value: string | number | Date, options?: Intl.DateTimeFormatOptions) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
}

const TranslationContext = createContext<TranslationContextValue | undefined>(undefined);

export function TranslationProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const initial = resolveInitialLocale();
    setLocale(initial);
    return initial;
  });

  useEffect(() => {
    const unsubscribe = subscribeToLocale(setLocaleState);
    return () => {
      unsubscribe();
    };
  }, []);

  const changeLocale = useCallback((next: Locale) => {
    setLocale(next);
    // A browser that refuses storage still gets the language for this session.
    writeLocalStorage(storageKey, next);
  }, []);

  const value = useMemo<TranslationContextValue>(
    () => ({
      locale,
      changeLocale,
      // `locale` is in the dependency list so every consumer re-renders on a
      // language change even though `translate` reads the module-level state.
      t: (source, params) => translate(source, params),
      formatDate: (input, options) => new Date(input).toLocaleString(intlLocale(), options),
      formatNumber: (input, options) => input.toLocaleString(intlLocale(), options),
    }),
    [locale, changeLocale],
  );

  return <TranslationContext.Provider value={value}>{children}</TranslationContext.Provider>;
}

export function useTranslation() {
  const value = useContext(TranslationContext);
  if (!value) {
    // Tests and isolated stories may render a component without the provider;
    // falling back keeps them rendering in the default language.
    return {
      locale: getLocale(),
      t: translate,
      changeLocale: setLocale,
      formatDate: (input: string | number | Date, options?: Intl.DateTimeFormatOptions) =>
        new Date(input).toLocaleString(intlLocale(), options),
      formatNumber: (input: number, options?: Intl.NumberFormatOptions) => input.toLocaleString(intlLocale(), options),
    } satisfies TranslationContextValue;
  }
  return value;
}
