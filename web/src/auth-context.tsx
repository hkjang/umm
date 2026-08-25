import { useMantineContext, type MantineColorScheme } from '@mantine/core';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { APIError, api, setOfflineQueueOwner, type Meta, type Preferences, type User } from './api';
import { isLocale, setLocale } from './i18n/translate';
import { readLocalStorage, removeLocalStorage, writeLocalStorage } from './lib/browser-storage';

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
  // Storage can be unavailable; the session default is still correct.
  if (isLocale(preferences.locale)) writeLocalStorage('umm:locale', preferences.locale);
}

const lastSessionKey = 'umm:last-session:v1';

/**
 * The account this browser last had a session for.
 *
 * Not a credential and not a substitute for one — every request still carries
 * the cookie, and the server decides. It exists so that being unable to reach
 * the server can be told apart from being signed out.
 *
 * Only what the shell needs to render is kept. The e-mail address is not part
 * of that.
 */
function rememberSession(user: User) {
  writeLocalStorage(
    lastSessionKey,
    JSON.stringify({ id: user.id, username: user.username, displayName: user.displayName, role: user.role }),
  );
}

function forgetSession() {
  removeLocalStorage(lastSessionKey);
}

function rememberedSession(): User | undefined {
  const stored = readLocalStorage(lastSessionKey);
  if (!stored.available || !stored.value) return undefined;
  try {
    const value = JSON.parse(stored.value) as Partial<User>;
    if (!value.id || !value.username) return undefined;
    return {
      id: value.id,
      username: value.username,
      displayName: value.displayName || value.username,
      email: '',
      role: value.role ?? 'user',
      active: true,
    };
  } catch {
    return undefined;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { setColorScheme } = useMantineContext();
  const [meta, setMeta] = useState<Meta>();
  const [user, setUser] = useState<User>();
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [metaResult, userResult] = await Promise.all([
      api<Meta>('/meta').catch(() => undefined),
      /*
       * Being unable to reach the server is not the same as being signed out,
       * and this had been treating them as one thing.
       *
       * The app precaches its shell and queues what you write while offline, so
       * a reload with no network serves the app — and then asked you to sign in,
       * which is the one thing you cannot do without a network. Thoughts already
       * queued were safe in storage, but you were looking at a login screen with
       * no way past it.
       *
       * A network failure arrives as status 0 and a real rejection as 401, so
       * the two are told apart here: fall back to the session this browser last
       * had, and clear it the moment the server actually says no.
       */
      api<User>('/me', { silent: true }).catch((reason) => {
        if (reason instanceof APIError && reason.status === 0) return rememberedSession();
        forgetSession();
        return undefined;
      }),
    ]);
    await setOfflineQueueOwner(userResult?.id);
    if (metaResult) setMeta(metaResult);
    setUser(userResult);
    if (userResult) {
      rememberSession(userResult);
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
    await setOfflineQueueOwner(undefined);
    forgetSession();
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
