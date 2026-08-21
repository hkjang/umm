import { useMantineContext, type MantineColorScheme } from '@mantine/core';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setOfflineQueueOwner, type Meta, type Preferences, type User } from './api';
import { isLocale, setLocale } from './i18n/translate';

interface AuthContextValue {
  meta?: Meta;
  user?: User;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/**
 * applyStoredPreferences carries the account's language and theme to whichever
 * browser the user signed in from. Language uses the same storage key the
 * pre-paint script reads. Theme goes through Mantine's active manager so the
 * current tab changes immediately and the manager persists the next reload.
 */
function applyStoredPreferences(
  preferences: Preferences | undefined,
  setColorScheme: (value: MantineColorScheme) => void,
) {
  if (!preferences) return;
  if (isLocale(preferences.locale)) setLocale(preferences.locale);
  if (preferences.theme === 'light' || preferences.theme === 'dark' || preferences.theme === 'system') {
    setColorScheme(preferences.theme === 'system' ? 'auto' : preferences.theme);
  }
  try {
    if (isLocale(preferences.locale)) localStorage.setItem('umm:locale', preferences.locale);
  } catch {
    // Storage can be unavailable; the session default is still correct.
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { setColorScheme } = useMantineContext();
  const [meta, setMeta] = useState<Meta>();
  const [user, setUser] = useState<User>();
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [metaResult, userResult] = await Promise.all([
      api<Meta>('/meta'),
      api<User>('/me', { silent: true }).catch(() => undefined),
    ]);
    setOfflineQueueOwner(userResult?.id);
    setMeta(metaResult);
    setUser(userResult);
    if (userResult) {
      applyStoredPreferences(
        await api<Preferences>('/preferences', { silent: true }).catch(() => undefined),
        setColorScheme,
      );
    }
  }, [setColorScheme]);

  // Authentication bootstrap intentionally runs once. A provider color-scheme
  // change can replace Mantine's setter but must not repeat the login fetch.
  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, []); // oxlint-disable-line react-hooks/exhaustive-deps, react/exhaustive-effect-dependencies

  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' });
    setOfflineQueueOwner(undefined);
    setUser(undefined);
  }, []);

  const value = useMemo(() => ({ meta, user, loading, refresh, logout }), [meta, user, loading, refresh, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used within AuthProvider');
  return value;
}
