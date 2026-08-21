import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
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
 * browser the user signed in from. It writes into the same storage keys the
 * pre-paint script and the i18n module read, so a later reload starts in the
 * right language and theme with no flash.
 */
function applyStoredPreferences(preferences?: Preferences) {
  if (!preferences) return;
  if (isLocale(preferences.locale)) setLocale(preferences.locale);
  try {
    if (isLocale(preferences.locale)) localStorage.setItem('umm:locale', preferences.locale);
    if (preferences.theme === 'light' || preferences.theme === 'dark') {
      localStorage.setItem('mantine-color-scheme-value', preferences.theme);
    }
  } catch {
    // Storage can be unavailable; the session default is still correct.
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [meta, setMeta] = useState<Meta>();
  const [user, setUser] = useState<User>();
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    const [metaResult, userResult] = await Promise.all([
      api<Meta>('/meta'),
      api<User>('/me', { silent: true }).catch(() => undefined),
    ]);
    setOfflineQueueOwner(userResult?.id);
    setMeta(metaResult);
    setUser(userResult);
    if (userResult) {
      applyStoredPreferences(await api<Preferences>('/preferences', { silent: true }).catch(() => undefined));
    }
  };

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, []);

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' });
    setOfflineQueueOwner(undefined);
    setUser(undefined);
  };

  const value = useMemo(() => ({ meta, user, loading, refresh, logout }), [meta, user, loading]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used within AuthProvider');
  return value;
}
