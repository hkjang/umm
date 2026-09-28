import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginSilentSso,
  clearSilentSsoState,
  insideSite,
  markSignedOut,
  shouldAttemptSilentSso,
  signInReturnTo,
  silentSsoReturnTo,
  ssoLoginUrl,
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

// Both ways in from the login screen go back to the address that was opened.
// A refused silent attempt and a failed SSO callback land on /login and carry
// that address in return_to; anything that would leave the site is dropped.
describe('where signing in returns to', () => {
  it('is the address the login screen was drawn at', () => {
    expect(signInReturnTo(at('/space/abc', '?note=1', '#x'))).toBe('/space/abc?note=1#x');
  });

  it('is the carried address on /login', () => {
    expect(signInReturnTo(at('/login', '?sso=none&return_to=%2Fspace%2Fabc'))).toBe('/space/abc');
    expect(signInReturnTo(at('/login', '?sso=error'))).toBe('/');
  });

  it('never leaves the site', () => {
    for (const outside of ['https://evil.example/', '//evil.example/x', '/\\evil.example/x', 'evil']) {
      expect(insideSite(outside)).toBe('/');
      expect(signInReturnTo(at('/login', `?return_to=${encodeURIComponent(outside)}`))).toBe('/');
    }
  });

  it('is passed to the organization-account login', () => {
    expect(ssoLoginUrl('/space/abc?note=1')).toBe('/api/v1/auth/oidc/start?return_to=%2Fspace%2Fabc%3Fnote%3D1');
    expect(ssoLoginUrl('/')).toBe('/api/v1/auth/oidc/start');
    expect(ssoLoginUrl('//evil.example')).toBe('/api/v1/auth/oidc/start');
  });
});
