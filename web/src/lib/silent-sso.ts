import { readSessionStorage, removeSessionStorage, writeSessionStorage } from './browser-storage';

/*
 * Silent SSO: someone already signed in at Keycloak opens umm and is inside,
 * with no login screen in between.
 *
 * The browser goes to the provider with prompt=none — a top-level navigation,
 * not a hidden frame, so it works where third-party cookies are blocked and
 * does not depend on the provider allowing frames. prompt=none never draws a
 * screen: either a code comes straight back and the ordinary login completes,
 * or the provider answers login_required. That answer is not a failure; it
 * means "ask the person". The one thing that must not happen on it is another
 * silent attempt, because then the browser bounces between here and the
 * provider for as long as the person watches it flicker.
 *
 * So this file is mostly about not trying. Three guards, each covering a way
 * the others can be lost:
 *   1. once per tab session — a mark in sessionStorage (not localStorage: a new
 *      tab should try again; a reload after a refusal should not);
 *   2. not after signing out on purpose — being signed straight back in would
 *      look like logout is broken;
 *   3. not when the address says the last attempt was refused — the callback
 *      lands on /login?sso=none, which survives cleared storage.
 * And when storage cannot be read at all — private modes, blocked site data —
 * that counts as "already tried". Reading it as "not yet" is the loop.
 */

const attemptedKey = 'umm:sso:attempted:v1';
const signedOutKey = 'umm:sso:signed-out:v1';

/** Paths that are never a place to start from: the login flow's own, and the API's. */
const excludedPaths = [/^\/login(\/|$)/, /^\/api(\/|$)/, /^\/mcp(\/|$)/, /^\/healthz$/, /^\/readyz$/, /^\/metrics$/];

function flag(key: string): boolean {
  const stored = readSessionStorage(key);
  // Unreadable storage fails closed: the mark may well be there.
  return !stored.available || stored.value === '1';
}

/** Records that the person signed out on purpose, which suppresses auto-login. */
export function markSignedOut() {
  writeSessionStorage(signedOutKey, '1');
  writeSessionStorage(attemptedKey, '1');
}

/** Lifts the suppression once a session exists again. */
export function clearSilentSsoState() {
  removeSessionStorage(signedOutKey);
  removeSessionStorage(attemptedKey);
}

export interface SilentSsoSite {
  oidcEnabled: boolean;
  oidcAutoLogin: boolean;
}

/**
 * Whether to try signing in without showing a login screen, given what the
 * server says about itself and where the browser is.
 *
 * Only ever true once per tab session, and never on the login flow's own paths.
 */
export function shouldAttemptSilentSso(
  site: SilentSsoSite | undefined,
  location: Pick<Location, 'pathname' | 'search'>,
) {
  if (!site?.oidcEnabled || !site.oidcAutoLogin) return false;
  if (excludedPaths.some((pattern) => pattern.test(location.pathname))) return false;
  // The callback appends this marker when the provider had no session, so a
  // refusal is remembered even if sessionStorage was cleared in between.
  const params = new URLSearchParams(location.search);
  if (params.has('sso')) return false;
  if (flag(signedOutKey) || flag(attemptedKey)) return false;
  return true;
}

/** Where a silent attempt should land: the address being opened, kept inside the site. */
export function silentSsoReturnTo(location: Pick<Location, 'pathname' | 'search' | 'hash'>) {
  const target = location.pathname + location.search + location.hash;
  return target.startsWith('/') && !target.startsWith('//') ? target : '/';
}

/** Sends the browser to the provider for a silent attempt. Marks the attempt first, so a failure to return still counts. */
export function beginSilentSso(
  returnTo: string,
  navigate: (url: string) => void = (url) => window.location.assign(url),
) {
  writeSessionStorage(attemptedKey, '1');
  navigate(`/api/v1/auth/oidc/start?prompt=none&return_to=${encodeURIComponent(returnTo)}`);
}
