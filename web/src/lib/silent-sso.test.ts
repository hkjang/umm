import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginSilentSso,
  clearSilentSsoState,
  markSignedOut,
  shouldAttemptSilentSso,
  silentSsoReturnTo,
} from './silent-sso';

const on = { oidcEnabled: true, oidcAutoLogin: true };
const at = (pathname: string, search = '', hash = '') => ({ pathname, search, hash });

// prompt=none answers login_required when there is no session, and trying
// again on that answer is the loop — the browser bouncing between umm and
// Keycloak while the person watches the screen flicker. Every rule here is a
// reason not to try.
describe('silent SSO', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('is the administrator’s to turn on, and off by default', () => {
    expect(shouldAttemptSilentSso(undefined, at('/today'))).toBe(false);
    expect(shouldAttemptSilentSso({ oidcEnabled: true, oidcAutoLogin: false }, at('/today'))).toBe(false);
    expect(shouldAttemptSilentSso({ oidcEnabled: false, oidcAutoLogin: true }, at('/today'))).toBe(false);
    expect(shouldAttemptSilentSso(on, at('/today'))).toBe(true);
  });

  it('tries once per tab session: a reload after a refusal does not try again', () => {
    expect(shouldAttemptSilentSso(on, at('/today'))).toBe(true);
    const navigate = vi.fn();
    beginSilentSso('/today', navigate);
    expect(navigate).toHaveBeenCalledWith('/api/v1/auth/oidc/start?prompt=none&return_to=%2Ftoday');
    expect(shouldAttemptSilentSso(on, at('/today'))).toBe(false);
  });

  it('does not try after signing out on purpose, until a session is seen again', () => {
    markSignedOut();
    expect(shouldAttemptSilentSso(on, at('/today'))).toBe(false);
    clearSilentSsoState();
    expect(shouldAttemptSilentSso(on, at('/today'))).toBe(true);
  });

  it('does not try when the address carries the provider’s refusal, even with storage cleared', () => {
    expect(shouldAttemptSilentSso(on, at('/login', '?sso=none'))).toBe(false);
    expect(shouldAttemptSilentSso(on, at('/login', '?sso=error'))).toBe(false);
    expect(shouldAttemptSilentSso(on, at('/today', '?sso=none'))).toBe(false);
  });

  it('counts unreadable storage as already tried — failing closed is the only safe reading', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('storage denied', 'SecurityError');
    });
    expect(shouldAttemptSilentSso(on, at('/today'))).toBe(false);
  });

  it('never starts from the login flow’s own paths or the API’s', () => {
    for (const path of ['/login', '/login/', '/api/v1/auth/oidc/callback', '/mcp', '/healthz', '/readyz', '/metrics']) {
      expect(shouldAttemptSilentSso(on, at(path)), path).toBe(false);
    }
    expect(shouldAttemptSilentSso(on, at('/space/abc'))).toBe(true);
  });

  it('brings a deep link along, kept inside the site', () => {
    expect(silentSsoReturnTo(at('/space/abc', '?note=1', '#top'))).toBe('/space/abc?note=1#top');
    const navigate = vi.fn();
    beginSilentSso(silentSsoReturnTo(at('/space/abc', '?note=1')), navigate);
    expect(navigate).toHaveBeenCalledWith(
      '/api/v1/auth/oidc/start?prompt=none&return_to=' + encodeURIComponent('/space/abc?note=1'),
    );
    expect(silentSsoReturnTo(at('//evil.example/x'))).toBe('/');
  });
});
