/*
 * Sending a space to another in-house service.
 *
 * A thought starts here, becomes a document in muni, slides in ptium, a report
 * in weekly — and at every step somebody downloaded a file and uploaded it
 * again. The formats already fit; what was missing was the hand.
 *
 * umm asks its own server for a claim — a single-use token, good for five
 * minutes, bound to this space and this person — and opens the receiving
 * service at <origin>/handoff?source=<umm>&claim=<claim>. That service
 * collects the document from umm with the claim. Nobody downloads anything,
 * and no service holds a credential for another.
 *
 * The only browser subtlety is the popup blocker. A window opened after an
 * await is a window opened outside the click, which is a window the browser
 * may refuse. So the window is opened first, blank, in the click itself, and
 * pointed at the receiving service once the claim arrives — or closed if it
 * never does.
 */

export interface HandoffTarget {
  name: string;
  origin: string;
}

export interface HandoffClaim {
  claim: string;
  source: string;
  filename: string;
  content_type: string;
  bytes: number;
  expires_at: string;
}

/** The address the receiving service is opened at. Exactly the standard's shape. */
export function handoffUrl(target: HandoffTarget, claim: Pick<HandoffClaim, 'claim' | 'source'>): string {
  const params = new URLSearchParams({ source: claim.source, claim: claim.claim });
  return `${target.origin.replace(/\/+$/, '')}/handoff?${params.toString()}`;
}

/** What a target origin must look like before umm will open it: a scheme and a host, nothing after. */
export function isHandoffOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      parsed.username === '' &&
      parsed.password === '' &&
      (parsed.pathname === '/' || parsed.pathname === '') &&
      parsed.search === '' &&
      parsed.hash === ''
    );
  } catch {
    return false;
  }
}

type WindowOpener = (url?: string, target?: string) => { location: { href: string }; close: () => void } | null;

/**
 * Opens the receiving service with a fresh claim.
 *
 * Returns false when the browser refused the window, so the caller can say
 * so; throws whatever issuing the claim threw, after closing the window it
 * had opened for it.
 */
export async function openHandoff(
  target: HandoffTarget,
  issue: () => Promise<HandoffClaim>,
  open: WindowOpener = (url, name) => window.open(url, name),
): Promise<boolean> {
  if (!isHandoffOrigin(target.origin)) throw new Error(`Not a service origin: ${target.origin}`);
  const opened = open('', '_blank');
  if (!opened) return false;
  let claim: HandoffClaim;
  try {
    claim = await issue();
  } catch (error) {
    opened.close();
    throw error;
  }
  opened.location.href = handoffUrl(target, claim);
  return true;
}
