import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslationProvider } from '../i18n';
import { setLocale } from '../i18n/translate';
import OfflineStatus from './OfflineStatus';

const state = { queued: 0, conflicts: 0 };
const flush = vi.fn(async () => ({ synced: 0, remaining: state.queued }));
const replay = vi.fn(() => state.conflicts);

vi.mock('../api', () => ({
  flushOfflineQueue: () => flush(),
  offlineQueueCount: () => state.queued,
  offlineConflictCount: () => state.conflicts,
  replayOfflineConflicts: () => replay(),
}));

function renderBanner() {
  return render(
    <MantineProvider>
      <TranslationProvider>
        <OfflineStatus />
      </TranslationProvider>
    </MantineProvider>,
  );
}

describe('OfflineStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    localStorage.setItem('umm:locale', 'ko');
    setLocale('ko');
    state.queued = 0;
    state.conflicts = 0;
  });

  it('offers to sync a change that is only waiting to be sent', async () => {
    state.queued = 1;
    renderBanner();

    expect(await screen.findByText('1개 변경이 연결을 기다리는 중')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '지금 동기화' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '겹침 확인' })).not.toBeInTheDocument();
  });

  /*
   * A version conflict is a decision, and every flush skips the change holding
   * one. Reported as waiting for a connection, next to a sync button that will
   * not move it, the reader is told to wait for something that has already
   * happened — and given no way back to the comparison that would end it.
   */
  it('names the decision a held conflict is waiting on, and asks for it again', async () => {
    state.queued = 1;
    state.conflicts = 1;
    renderBanner();

    expect(await screen.findByText('1개 변경이 겹침 해결을 기다리는 중')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '지금 동기화' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '겹침 확인' }));
    expect(replay).toHaveBeenCalledOnce();
  });

  // Two changes, one of them held: syncing still has work to do, so both ways
  // out stay on offer.
  it('keeps syncing on offer while other changes can still be sent', async () => {
    state.queued = 2;
    state.conflicts = 1;
    renderBanner();

    expect(await screen.findByText('1개 변경이 겹침 해결을 기다리는 중')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '겹침 확인' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '지금 동기화' })).toBeInTheDocument();
  });
});
