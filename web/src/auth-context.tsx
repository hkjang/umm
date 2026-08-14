import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type Meta, type User } from './api';

interface AuthContextValue {
  meta?: Meta;
  user?: User;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [meta, setMeta] = useState<Meta>();
  const [user, setUser] = useState<User>();
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    const [metaResult, userResult] = await Promise.all([
      api<Meta>('/meta'),
      api<User>('/me', { silent: true }).catch(() => undefined),
    ]);
    setMeta(metaResult);
    setUser(userResult);
  };

  useEffect(() => { refresh().finally(() => setLoading(false)); }, []);
  const logout = async () => { await api('/auth/logout', { method: 'POST' }); setUser(undefined); };
  const value = useMemo(() => ({ meta, user, loading, refresh, logout }), [meta, user, loading]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used within AuthProvider');
  return value;
}
