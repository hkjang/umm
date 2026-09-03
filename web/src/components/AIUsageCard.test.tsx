import { MantineProvider } from '@mantine/core';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslationProvider } from '../i18n';
import { setLocale } from '../i18n/translate';
import AIUsageCard from './AIUsageCard';

const api = vi.hoisted(() => vi.fn());
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, api };
});

const answer = (over: Record<string, unknown> = {}) => ({
  usage: { entries: [], counts: {}, total: 0, truncated: false, retentionDays: 90 },
  since: '2026-08-04T00:00:00Z',
  days: 30,
  embeddingsLeaveThisMachine: false,
  embeddingModel: '',
  ...over,
});

const show = () =>
  render(
    <MantineProvider>
      <TranslationProvider>
        <AIUsageCard />
      </TranslationProvider>
    </MantineProvider>,
  );

describe('AIUsageCard', () => {
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

  // The first way this screen could lie: an empty list reading as "nothing
  // happened" when the log is cleaned up on a schedule.
  it('says an empty list is about the window, not about the year', async () => {
    api.mockResolvedValue(answer());
    show();
    expect(
      await screen.findByText(
        '최근 30일 동안 기록된 호출이 없습니다. 기록은 90일 뒤 삭제되므로, 그보다 오래된 일은 여기에 남지 않습니다.',
      ),
    ).toBeInTheDocument();
  });

  // The second way: a list of chat-model calls reading as the whole story when
  // indexing sends note bodies out too.
  it('states that indexing sends note bodies out, when it does', async () => {
    api.mockResolvedValue(answer({ embeddingsLeaveThisMachine: true, embeddingModel: 'bge-m3' }));
    show();
    expect(await screen.findByText(/임베딩 게이트웨이\(bge-m3\)로 보냅니다/)).toBeInTheDocument();
    expect(screen.getByText(/아래 목록에는 없습니다/)).toBeInTheDocument();
  });

  // And the opposite has to be stated too, or "nothing said" is ambiguous.
  it('states that note bodies stay put, when they do', async () => {
    api.mockResolvedValue(answer());
    show();
    expect(
      await screen.findByText(
        '메모 본문은 임베딩을 위해 이 서버 밖으로 나가지 않습니다. 검색과 연결은 로컬에서 계산합니다.',
      ),
    ).toBeInTheDocument();
  });

  it('lists a call with what it was for', async () => {
    api.mockResolvedValue(
      answer({
        usage: {
          entries: [
            {
              at: '2026-09-03T01:00:00Z',
              purpose: 'assist',
              model: 'a-model',
              status: 'success',
              inputTokens: 1,
              outputTokens: 2,
            },
          ],
          counts: { assist: 1 },
          total: 1,
          truncated: false,
          retentionDays: 90,
        },
      }),
    );
    show();
    expect(await screen.findByRole('cell', { name: 'AI Assist' })).toBeInTheDocument();
    expect(screen.getByText('AI Assist 1')).toBeInTheDocument();
  });

  // A failed call still sent the prompt, so it is on the list and says so.
  it('lists a failed call rather than hiding it as a non-event', async () => {
    api.mockResolvedValue(
      answer({
        usage: {
          entries: [
            {
              at: '2026-09-03T01:00:00Z',
              purpose: 'ask',
              model: 'a-model',
              status: 'failed',
              inputTokens: 1,
              outputTokens: 0,
            },
          ],
          counts: { ask: 1 },
          total: 1,
          truncated: false,
          retentionDays: 90,
        },
      }),
    );
    show();
    expect(await screen.findByRole('cell', { name: '기억에 질문' })).toBeInTheDocument();
    expect(screen.getByText('실패')).toBeInTheDocument();
  });

  // A call recorded before the purpose existed must not be given a label it
  // never had.
  it('does not invent a purpose for a call that has none', async () => {
    api.mockResolvedValue(
      answer({
        usage: {
          entries: [
            {
              at: '2026-09-03T01:00:00Z',
              purpose: '',
              model: 'a-model',
              status: 'success',
              inputTokens: 1,
              outputTokens: 2,
            },
          ],
          counts: { '': 1 },
          total: 1,
          truncated: false,
          retentionDays: 90,
        },
      }),
    );
    show();
    expect(await screen.findByRole('cell', { name: '기록되지 않음' })).toBeInTheDocument();
  });

  it('says when the window held more than it showed', async () => {
    api.mockResolvedValue(
      answer({
        usage: {
          entries: [
            {
              at: '2026-09-03T01:00:00Z',
              purpose: 'dream',
              model: 'a-model',
              status: 'success',
              inputTokens: 1,
              outputTokens: 2,
            },
          ],
          counts: { dream: 412 },
          total: 412,
          truncated: true,
          retentionDays: 90,
        },
      }),
    );
    show();
    expect(await screen.findByText('이 기간에 호출이 412번 있었고, 그중 최근 1번만 표시했습니다.')).toBeInTheDocument();
  });

  it('asks the server for the window that is selected', async () => {
    api.mockResolvedValue(answer());
    show();
    await waitFor(() => expect(api).toHaveBeenCalledWith('/ai-usage?days=30'));
  });
});
