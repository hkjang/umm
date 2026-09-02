import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslationProvider } from '../i18n';
import { setLocale } from '../i18n/translate';
import PresentationModal, { type PresentationPreview } from './PresentationModal';

const api = vi.hoisted(() => vi.fn());
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, api };
});

const slide = (title: string, thoughts: string[]) => ({
  Role: 'content' as const,
  Title: title,
  Lead: '',
  Points: null,
  From: thoughts,
});

const preview = (over: Partial<PresentationPreview['storyline']> = {}): PresentationPreview => ({
  storyline: {
    Title: '회고 주기 재검토',
    Slides: [slide('첫째', ['t1']), slide('둘째', ['t2'])],
    Excluded: null,
    ...over,
  },
  source: '# 회고 주기 재검토\n',
  slideCount: 0,
  warnings: [],
  checked: false,
});

const open = () =>
  render(
    <MantineProvider>
      <TranslationProvider>
        <PresentationModal opened onClose={vi.fn()} spaceID="s1" spaceName="회고 주기 재검토" />
      </TranslationProvider>
    </MantineProvider>,
  );

describe('PresentationModal', () => {
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

  const answer = (body: PresentationPreview) => {
    api.mockImplementation((path: string) => {
      if (path.includes('/presentation/preview')) return Promise.resolve(body);
      if (path.endsWith('/presentations')) return Promise.resolve({ presentations: [] });
      return Promise.resolve({ link: { ptiumId: 'pt_1' }, warnings: [] });
    });
  };

  const previewPaths = () =>
    api.mock.calls.map(([path]) => String(path)).filter((path) => path.includes('/presentation/preview'));

  // A length nobody set is no length. A deck is a whole space until somebody
  // says how long they have.
  it('asks for no length until one is chosen', async () => {
    answer(preview());
    open();
    await waitFor(() => expect(previewPaths().length).toBeGreaterThan(0));
    expect(previewPaths().every((path) => !path.includes('maxSlides'))).toBe(true);
  });

  // The deck has to be made to the length the preview showed. Sending the
  // length to one and not the other would hand over a talk nobody reviewed —
  // and a guard applied to every path but one is how that happens.
  it('sends the chosen length to both the preview and the deck', async () => {
    answer(preview());
    open();
    await waitFor(() => expect(previewPaths().length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('radio', { name: '20장' }));
    await waitFor(() => expect(previewPaths().some((path) => path.includes('maxSlides=20'))).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Ptium에서 만들기' }));
    await waitFor(() => {
      const post = api.mock.calls.find(
        ([path, opts]) => String(path).endsWith('/presentations') && opts?.method === 'POST',
      );
      expect(post).toBeDefined();
      expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ maxSlides: 20 });
    });
  });

  // Dropping a thought out of somebody's own space without saying so is the one
  // thing this must never do.
  it('says how many thoughts did not fit', async () => {
    answer(preview({ Trimmed: ['t3', 't4', 't5'], TrimmedSlides: 2 }));
    open();
    expect(
      await screen.findByText('생각 3개는 분량에 들어가지 못했습니다. 연결이 적은 슬라이드부터 빠집니다.'),
    ).toBeInTheDocument();
    expect(screen.getByText('3개 분량 밖')).toBeInTheDocument();
  });

  // The absence has to be provable: without this, a broken notice and a deck
  // where everything fit look identical.
  it('says nothing about length when everything fit', async () => {
    answer(preview());
    open();
    await waitFor(() => expect(previewPaths().length).toBeGreaterThan(0));
    expect(screen.queryByText(/분량에 들어가지 못했습니다/)).toBeNull();
    expect(screen.queryByText(/분량 밖/)).toBeNull();
  });
});
