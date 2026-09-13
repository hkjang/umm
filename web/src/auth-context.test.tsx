import { MantineProvider, useMantineColorScheme } from '@mantine/core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './auth-context';
import { setLocale } from './i18n/translate';

const mocks = vi.hoisted(() => ({
  theme: 'dark',
  api: vi.fn(),
  setOfflineQueueOwner: vi.fn(),
  beginSilentSso: vi.fn(),
}));

vi.mock('./api', () => ({
  api: mocks.api,
  setOfflineQueueOwner: mocks.setOfflineQueueOwner,
  APIError: class APIError extends Error {
    constructor(public status: number) {
      super(`HTTP ${status}`);
    }
  },
}));

// The decision to leave is real; only the leaving itself is stubbed, because
// jsdom cannot navigate.
vi.mock('./lib/silent-sso', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/silent-sso')>()),
  beginSilentSso: mocks.beginSilentSso,
}));

function SessionProbe() {
  const { colorScheme } = useMantineColorScheme();
  const { user, loading } = useAuth();
  return (
    <div>
      <span data-testid="scheme">{colorScheme}</span>
      <span data-testid="username">{user?.username}</span>
      <span data-testid="loading">{String(loading)}</span>
    </div>
  );
}

function renderProvider() {
  return render(
    <MantineProvider defaultColorScheme="auto">
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>
    </MantineProvider>,
  );
}

describe('AuthProvider stored appearance', () => {
  beforeEach(() => {
    localStorage.clear();
    setLocale('ko');
    mocks.theme = 'dark';
    mocks.api.mockReset();
    mocks.setOfflineQueueOwner.mockReset();
    mocks.api.mockImplementation(async (path: string) => {
      if (path === '/meta') {
        return {
          serviceName: 'umm',
          version: 'test',
          oidcEnabled: false,
          dreamEnabled: true,
          dreamAllowUserDisable: true,
          mcpProtocol: '2025-06-18',
        };
      }
      if (path === '/me') {
        return {
          id: 'user-1',
          username: 'stored-theme-user',
          displayName: 'Stored Theme User',
          email: '',
          role: 'user',
          active: true,
        };
      }
      if (path === '/preferences') {
        return {
          dream_enabled: true,
          dream_frequency: 'daily',
          dream_style: 'auto',
          dream_notifications: false,
          include_old_notes: true,
          theme: mocks.theme,
          locale: 'ko',
          edge_style: 'bezier',
          review_digest: true,
        };
      }
      throw new Error(`unexpected API path: ${path}`);
    });
  });

  afterEach(cleanup);

  it('applies the account theme to the active Mantine provider immediately', async () => {
    renderProvider();

    expect(await screen.findByTestId('username')).toHaveTextContent('stored-theme-user');
    await waitFor(() => expect(screen.getByTestId('scheme')).toHaveTextContent('dark'));
    expect(document.documentElement).toHaveAttribute('data-mantine-color-scheme', 'dark');
    expect(localStorage.getItem('mantine-color-scheme-value')).toBe('dark');
  });

  it('maps the stored system preference to Mantine automatic mode', async () => {
    localStorage.setItem('mantine-color-scheme-value', 'dark');
    mocks.theme = 'system';
    renderProvider();

    await waitFor(() => expect(screen.getByTestId('scheme')).toHaveTextContent('auto'));
    expect(document.documentElement).toHaveAttribute('data-mantine-color-scheme', 'light');
    expect(localStorage.getItem('mantine-color-scheme-value')).toBe('auto');
  });
});

// Someone already signed in at Keycloak should walk in without a login screen;
// someone who is not should see it once, not a browser bouncing to the
// provider and back.
describe('AuthProvider silent SSO', () => {
  const signedOut = (autoLogin: boolean) => {
    mocks.api.mockImplementation(async (path: string) => {
      if (path === '/meta') {
        return {
          serviceName: 'umm',
          version: 'test',
          oidcEnabled: true,
          oidcAutoLogin: autoLogin,
          dreamEnabled: false,
          dreamAllowUserDisable: false,
          mcpProtocol: '2025-06-18',
        };
      }
      const { APIError } = await import('./api');
      throw new APIError(401, 'no session');
    });
  };

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    mocks.api.mockReset();
    mocks.setOfflineQueueOwner.mockReset();
    mocks.beginSilentSso.mockReset();
    window.history.replaceState(null, '', '/space/abc?note=1');
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState(null, '', '/');
  });

  it('leaves for the provider before the login screen is drawn, bringing the deep link', async () => {
    signedOut(true);
    renderProvider();

    await waitFor(() => expect(mocks.beginSilentSso).toHaveBeenCalledWith('/space/abc?note=1'));
    // The spinner stays up on the way out; a login form must not flash first.
    expect(screen.getByTestId('loading')).toHaveTextContent('true');
  });

  it('shows the login screen when the address says the last try was refused', async () => {
    signedOut(true);
    window.history.replaceState(null, '', '/login?sso=none');
    renderProvider();

    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(mocks.beginSilentSso).not.toHaveBeenCalled();
  });

  it('changes nothing while the administrator has auto-login off', async () => {
    signedOut(false);
    renderProvider();

    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(mocks.beginSilentSso).not.toHaveBeenCalled();
  });
});
