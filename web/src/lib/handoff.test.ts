import { describe, expect, it, vi } from 'vitest';
import { handoffUrl, isHandoffOrigin, openHandoff, type HandoffClaim } from './handoff';

const ptium = { name: 'Ptium', origin: 'https://ptium.intra' };
const claim: HandoffClaim = {
  claim: 'Qm9vazEyMzQ1Njc4OTA_-abc',
  source: 'https://umm.intra',
  filename: '2026년 3분기 개편안.md',
  content_type: 'text/markdown; charset=utf-8',
  bytes: 18342,
  expires_at: '2026-09-13T21:30:00+09:00',
};

// The standard's shape, and six services meet on it: /handoff with source
// and claim, on the receiving service's origin.
describe('handoff', () => {
  it('opens the receiving service at /handoff with source and claim', () => {
    expect(handoffUrl(ptium, claim)).toBe(
      'https://ptium.intra/handoff?source=https%3A%2F%2Fumm.intra&claim=Qm9vazEyMzQ1Njc4OTA_-abc',
    );
    expect(handoffUrl({ ...ptium, origin: 'https://ptium.intra/' }, claim)).toBe(handoffUrl(ptium, claim));
  });

  it('accepts only an origin — scheme and host, nothing after', () => {
    expect(isHandoffOrigin('https://ptium.intra')).toBe(true);
    expect(isHandoffOrigin('http://ptium.intra:8080/')).toBe(true);
    expect(isHandoffOrigin('https://ptium.intra/handoff')).toBe(false);
    expect(isHandoffOrigin('https://ptium.intra?x=1')).toBe(false);
    expect(isHandoffOrigin('https://user:pw@ptium.intra')).toBe(false);
    expect(isHandoffOrigin('javascript:alert(1)')).toBe(false);
    expect(isHandoffOrigin('ptium.intra')).toBe(false);
    expect(isHandoffOrigin('')).toBe(false);
  });

  // The window has to be opened inside the click, before the claim exists,
  // or the popup blocker takes it. So it opens blank and is pointed at the
  // service once the claim arrives.
  it('opens the window before asking for the claim, then points it at the service', async () => {
    const order: string[] = [];
    const opened = { location: { href: '' }, close: vi.fn() };
    const open = vi.fn(() => {
      order.push('open');
      return opened;
    });
    const issue = vi.fn(async () => {
      order.push('issue');
      return claim;
    });
    await expect(openHandoff(ptium, issue, open)).resolves.toBe(true);
    expect(order).toEqual(['open', 'issue']);
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(opened.location.href).toBe(handoffUrl(ptium, claim));
    expect(opened.close).not.toHaveBeenCalled();
  });

  it('closes the window it opened when the claim cannot be issued', async () => {
    const opened = { location: { href: '' }, close: vi.fn() };
    const issue = vi.fn(async () => {
      throw new Error('팀장 승인이 필요합니다.');
    });
    await expect(openHandoff(ptium, issue, () => opened)).rejects.toThrow('팀장 승인이 필요합니다.');
    expect(opened.close).toHaveBeenCalledTimes(1);
    expect(opened.location.href).toBe('');
  });

  it('reports a refused window without issuing a claim', async () => {
    const issue = vi.fn(async () => claim);
    await expect(openHandoff(ptium, issue, () => null)).resolves.toBe(false);
    expect(issue).not.toHaveBeenCalled();
  });

  it('refuses to open anything that is not a service origin', async () => {
    const open = vi.fn();
    await expect(openHandoff({ name: 'x', origin: 'javascript:alert(1)' }, async () => claim, open)).rejects.toThrow(
      'Not a service origin',
    );
    expect(open).not.toHaveBeenCalled();
  });
});
