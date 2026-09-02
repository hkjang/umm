import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslationProvider } from '../i18n';
import { setLocale } from '../i18n/translate';
import type { ThoughtEdge } from '../api';
import BacklinkRow from './BacklinkRow';

const api = vi.hoisted(() => vi.fn());
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, api };
});

const edge = (over: Partial<ThoughtEdge> = {}): ThoughtEdge => ({
  id: 'e1',
  spaceId: 's1',
  source: 'n1',
  target: 'n2',
  relation: 'supports',
  origin: 'manual',
  ...over,
});

const show = (over: Partial<ThoughtEdge> = {}, readOnly = false, onSaved = vi.fn()) => {
  render(
    <MantineProvider>
      <TranslationProvider>
        <BacklinkRow
          edge={edge(over)}
          title="주기가 짧으면 논의가 얕아진다"
          direction="incoming"
          onFocus={vi.fn()}
          readOnly={readOnly}
          onSaved={onSaved}
        />
      </TranslationProvider>
    </MantineProvider>,
  );
  return onSaved;
};

describe('BacklinkRow', () => {
  beforeEach(() => {
    api.mockReset();
    localStorage.clear();
    localStorage.setItem('umm:locale', 'ko');
    setLocale('ko');
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    });
  });

  it('shows the reason its author wrote', () => {
    show({ reason: '같은 회고록을 두 번 읽고 이었다' });
    expect(screen.getByText(/같은 회고록을 두 번 읽고 이었다/)).toBeInTheDocument();
  });

  // Writing it is what this exists for, and the reason has to reach the row
  // that shows it or the panel keeps displaying the old sentence.
  it('writes the reason and hands the saved connection back', async () => {
    const saved = { ...edge(), reason: '측정치가 나중에 나왔다' };
    api.mockResolvedValue(saved);
    const onSaved = show();

    fireEvent.click(screen.getByRole('button', { name: '왜 이었는지 적기' }));
    fireEvent.change(screen.getByPlaceholderText('왜 이었는지 한 줄'), {
      target: { value: '측정치가 나중에 나왔다' },
    });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    await waitFor(() => expect(api).toHaveBeenCalledOnce());
    const [path, options] = api.mock.calls[0];
    expect(path).toBe('/edges/e1/reason');
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body)).toEqual({ reason: '측정치가 나중에 나왔다' });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
  });

  // No reason is the normal state. A placeholder saying one is missing would
  // turn most of somebody's graph into a list of chores.
  it('says nothing about a connection nobody explained', () => {
    show();
    expect(screen.queryByText(/^왜:/)).toBeNull();
  });

  // Annotating a space is changing it, and the read-only screen must not offer
  // what the server will refuse.
  it('offers nothing to write when the space is read-only', () => {
    show({ reason: '이유가 있다' }, true);
    expect(screen.getByText(/이유가 있다/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '왜 이었는지 고치기' })).toBeNull();
    expect(screen.queryByRole('button', { name: '왜 이었는지 적기' })).toBeNull();
  });

  it('offers nothing to write on an unexplained connection either, when read-only', () => {
    show({}, true);
    expect(screen.queryByRole('button', { name: '왜 이었는지 적기' })).toBeNull();
  });

  // A refused save must keep what they typed rather than throwing it away.
  it('keeps the draft when saving fails', async () => {
    api.mockRejectedValue(new Error('nope'));
    show();
    fireEvent.click(screen.getByRole('button', { name: '왜 이었는지 적기' }));
    const field = screen.getByPlaceholderText('왜 이었는지 한 줄');
    fireEvent.change(field, { target: { value: '적다 만 문장' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(api).toHaveBeenCalledOnce());
    expect(screen.getByPlaceholderText('왜 이었는지 한 줄')).toHaveValue('적다 만 문장');
  });
});
