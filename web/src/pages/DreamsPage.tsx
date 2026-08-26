import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Menu,
  Modal,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Timeline,
  Title,
} from '@mantine/core';
import {
  IconArrowRight,
  IconBrain,
  IconBulb,
  IconEyeOff,
  IconMoonStars,
  IconRefresh,
  IconRoute,
  IconSparkles,
  IconWand,
} from '@tabler/icons-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, json, type ThoughtNote } from '../api';
import { msg, useTranslation } from '../i18n';
import { showSuccess } from '../ui-notifications';

interface DreamSource {
  noteId: string;
  title: string;
  excerpt: string;
  rank: number;
  similarityScore: number;
  cited: boolean;
}
interface Dream {
  dreamId: string;
  type: string;
  generatedAt: string;
  exposedAt?: string;
  acceptedAt?: string;
  qualityScore: number;
  qualityLabel: string;
  status: string;
  noteId?: string;
  spaceId: string;
  spaceName: string;
  content: string;
  rationale: string;
  suggestedAction: string;
  generation: number;
  dismissedReason?: string;
  sources: DreamSource[];
}
interface DevelopResult {
  mode: string;
  content: string;
}
interface DevelopedNoteResult {
  note: ThoughtNote;
  created: boolean;
}

const typeLabels: Record<string, string> = {
  connection: msg('연결'),
  question: msg('질문'),
  expansion: msg('확장'),
  contrarian: msg('반대 관점'),
  rediscovery: msg('재발견'),
  action: msg('다음 행동'),
  pattern: msg('패턴'),
};
const hideReasons = [
  ['too_obvious', msg('너무 뻔해요')],
  ['irrelevant', msg('관련이 없어요')],
  ['incorrect', msg('사실과 달라요')],
  ['repetitive', msg('반복되는 내용이에요')],
  ['too_frequent', msg('너무 자주 와요')],
];
const developModes = [
  ['expand', msg('더 구체적으로 확장')],
  ['challenge', msg('반대 관점에서 보기')],
  ['actions', msg('실행 항목으로 바꾸기')],
];

// The API returns this label as Korean text, so the colour rule compares
// against the raw server value while the badge renders a translated copy.
const wellSourcedLabel = msg('근거 충분');

/**
 * A tab's label, with its count when the server has sent one.
 *
 * Undefined rather than zero while the counts are still in flight, and
 * undefined again if counting failed — a tab that says 0 when the answer is
 * unknown is a claim, and this page has already been wrong about that number
 * once.
 */
function tabLabel(name: string, count: number | undefined): string {
  return count === undefined ? name : `${name} ${count}`;
}

export default function DreamsPage() {
  const navigate = useNavigate();
  const { t, formatDate } = useTranslation();
  const [params] = useSearchParams();
  const [dreams, setDreams] = useState<Dream[]>();
  const [nextCursor, setNextCursor] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('inbox');
  const [busy, setBusy] = useState('');
  const [developed, setDeveloped] = useState<{ dream: Dream; result: DevelopResult }>();
  // Counted by the server across every dream, not by this page across the ones
  // it happens to have loaded. Thirty arrive at a time, so counting what is in
  // hand counts the page rather than the queue — and it changed under the
  // reader the moment they pressed 이전 Dream 더 불러오기.
  const [counts, setCounts] = useState<Record<string, number>>();
  const exposed = useRef(new Set<string>());
  const focused = useRef('');
  const visible = useMemo(() => {
    const all = dreams || [];
    if (filter === 'inbox') return all.filter((d) => d.status === 'created' || d.status === 'exposed');
    if (filter === 'kept') return all.filter((d) => d.status === 'kept');
    if (filter === 'hidden') return all.filter((d) => d.status === 'deleted');
    return all;
  }, [dreams, filter]);
  const load = useCallback(async (cursor = '') => {
    setError('');
    if (cursor) setLoadingMore(true);
    try {
      const query = new URLSearchParams({ limit: '30' });
      if (cursor) query.set('cursor', cursor);
      const value = await api<{ dreams: Dream[]; nextCursor: string; counts?: Record<string, number> }>(
        `/dreams?${query}`,
      );
      setDreams((all) =>
        cursor
          ? [
              ...(all || []),
              ...value.dreams.filter((item) => !all?.some((existing) => existing.dreamId === item.dreamId)),
            ]
          : value.dreams,
      );
      setNextCursor(value.nextCursor || '');
      if (value.counts) setCounts(value.counts);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('Dream 기록을 불러오지 못했습니다.'));
      if (!cursor) {
        setDreams([]);
        setNextCursor('');
      }
    } finally {
      setLoadingMore(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const focus = params.get('focus');
    if (!focus || !dreams || focused.current === focus) return;
    const card = document.getElementById(`dream-${focus}`);
    if (!card) {
      const target = dreams.find((d) => d.dreamId === focus);
      if (target?.status === 'kept' && filter !== 'kept') setFilter('kept');
      else if (target?.status === 'deleted' && filter !== 'hidden') setFilter('hidden');
      else if (!target && nextCursor && !loadingMore) void load(nextCursor);
      return;
    }
    focused.current = focus;
    window.requestAnimationFrame(() => card.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  }, [dreams, filter, load, loadingMore, nextCursor, params]);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting || entry.intersectionRatio < 0.5) return;
          const id = (entry.target as HTMLElement).dataset.dreamId;
          if (!id || exposed.current.has(id)) return;
          exposed.current.add(id);
          observer.unobserve(entry.target);
          void api(`/dreams/${id}/feedback`, { ...json('POST', { action: 'exposed' }), silent: true })
            .then(() =>
              setDreams((all) =>
                all?.map((d) => (d.dreamId === id && d.status === 'created' ? { ...d, status: 'exposed' } : d)),
              ),
            )
            .catch(() => exposed.current.delete(id));
        });
      },
      { threshold: 0.5 },
    );
    visible
      .filter((d) => d.status === 'created')
      .forEach((d) => {
        const card = document.getElementById(`dream-${d.dreamId}`);
        if (card) observer.observe(card);
      });
    return () => observer.disconnect();
  }, [visible]);
  /**
   * Re-reads the counts after a dream changes state.
   *
   * Asked of the server rather than adjusted here, even though this page knows
   * exactly which way the dream moved. Adjusting locally would put the rule for
   * which status belongs to which tab in two places, and the reason these
   * numbers were wrong in the first place was a count derived from something
   * other than what it labelled. One dream is requested because the counts ride
   * along with the listing; the dreams on screen are left alone.
   */
  const refreshCounts = useCallback(async () => {
    try {
      const value = await api<{ counts?: Record<string, number> }>('/dreams?limit=1', { silent: true });
      if (value.counts) setCounts(value.counts);
    } catch {
      // A stale number is worse than none, but re-reading is the only way to
      // learn the new one — leaving what is shown alone is the least wrong of
      // the options here, and the next load corrects it.
    }
  }, []);

  /**
   * The day each visible dream belongs to, as the reader sees it written.
   *
   * Formatted rather than compared as timestamps, because the heading is what
   * they are looking at: two dreams an hour apart across midnight are different
   * days to them, and the formatter is what decides that — in their locale and
   * their calendar, not in UTC.
   */
  const days = useMemo(
    () => visible.map((d) => formatDate(d.generatedAt, { year: 'numeric', month: 'long', day: 'numeric' })),
    [visible, formatDate],
  );

  const replace = (next: Dream) => setDreams((all) => all?.map((d) => (d.dreamId === next.dreamId ? next : d)));
  const accept = async (dream: Dream, content = '') => {
    setBusy(`accept:${dream.dreamId}`);
    try {
      const note = await api<ThoughtNote>(`/dreams/${dream.dreamId}/accept`, json('POST', { content }));
      showSuccess(t('Dream을 생각 곁에 남겼습니다.'), t('Dream 채택'));
      navigate(`/space/${note.spaceId}?note=${note.id}`);
    } finally {
      setBusy('');
    }
  };
  const regenerate = async (dream: Dream) => {
    setBusy(`regenerate:${dream.dreamId}`);
    try {
      const next = await api<Dream>(`/dreams/${dream.dreamId}/regenerate`, { method: 'POST' });
      await api(`/dreams/${dream.dreamId}/feedback`, json('POST', { action: 'exposed' }));
      exposed.current.add(dream.dreamId);
      replace({ ...next, status: 'exposed' });
      showSuccess(t('같은 원본에서 다른 관점을 만들었습니다.'), t('Dream 재생성'));
    } finally {
      setBusy('');
    }
  };
  const hide = async (dream: Dream, reason: string) => {
    setBusy(`hide:${dream.dreamId}`);
    try {
      await api(`/dreams/${dream.dreamId}/feedback`, json('POST', { action: 'hidden', reason }));
      setDreams((all) =>
        all?.map((d) => (d.dreamId === dream.dreamId ? { ...d, status: 'deleted', dismissedReason: reason } : d)),
      );
      void refreshCounts();
      showSuccess(
        t(
          reason === 'too_frequent'
            ? '이 Dream을 숨기고 생성 빈도를 한 단계 낮췄습니다.'
            : '이 Dream을 숨기고 스타일 선호도에 반영했습니다.',
        ),
        t('피드백 반영'),
      );
    } finally {
      setBusy('');
    }
  };
  const develop = async (dream: Dream, mode: string) => {
    setBusy(`develop:${dream.dreamId}`);
    try {
      const result = await api<DevelopResult>(`/dreams/${dream.dreamId}/develop`, json('POST', { mode }));
      setDeveloped({ dream, result });
    } finally {
      setBusy('');
    }
  };
  const keepDeveloped = async () => {
    if (!developed) return;
    const { dream, result } = developed;
    if (!dream.noteId && dream.status !== 'kept') {
      await accept(dream, result.content);
      return;
    }
    setBusy(`develop:${dream.dreamId}`);
    try {
      const saved = await api<DevelopedNoteResult>(
        `/dreams/${dream.dreamId}/developed-note`,
        json('POST', { content: result.content }),
      );
      setDeveloped(undefined);
      navigate(`/space/${saved.note.spaceId}?note=${saved.note.id}`);
    } finally {
      setBusy('');
    }
  };
  return (
    <div className="settings-page">
      <Stack maw={900} mx="auto" gap="xl">
        <Group justify="space-between" align="flex-end">
          <Group>
            <ThemeIcon size={42} radius="xl" color="grape" variant="light">
              <IconMoonStars />
            </ThemeIcon>
            <div>
              <Title order={1}>Dreams</Title>
              <Text c="dimmed">{t('근거를 확인하고 내 생각으로 채택하는 AI 인사이트')}</Text>
            </div>
          </Group>
          <Button variant="subtle" leftSection={<IconRefresh size={16} />} onClick={() => void load()}>
            {t('새로고침')}
          </Button>
        </Group>
        <SegmentedControl
          fullWidth
          value={filter}
          onChange={setFilter}
          data={[
            { value: 'inbox', label: tabLabel(t('검토함'), counts?.inbox) },
            { value: 'kept', label: tabLabel(t('채택됨'), counts?.kept) },
            { value: 'hidden', label: tabLabel(t('숨김'), counts?.hidden) },
            { value: 'all', label: tabLabel(t('전체'), counts?.all) },
          ]}
        />
        {error && (
          <Alert color="red" title={t('Dream을 불러오지 못했습니다.')}>
            <Group justify="space-between" align="center" wrap="nowrap">
              <Text size="sm">{error}</Text>
              <Button size="xs" variant="light" color="red" onClick={() => void load()}>
                {t('다시 시도')}
              </Button>
            </Group>
          </Alert>
        )}
        {/*
         * The "nothing here yet" card is only true when the answer arrived.
         *
         * A failed load emptied the list as well as raising the alert, so the
         * page said "couldn't load" and, right under it, "you have no Dreams —
         * keep adding thoughts and they will arrive". The second is friendlier,
         * larger, and wrong, and it is the one a person believes.
         */}
        {!dreams ? (
          <Loader />
        ) : visible.length === 0 && !error ? (
          <Stack>
            <Card p={45} radius="lg" withBorder ta="center">
              <IconMoonStars size={38} color="#8c7a9f" />
              <Title order={3} mt="md">
                {t(filter === 'inbox' ? '검토할 Dream이 없어요' : '이 상태의 Dream이 없어요')}
              </Title>
              <Text c="dimmed" mt="sm">
                {t('충분한 생각이 쌓이면 근거와 함께 새로운 관점이 이곳에 도착합니다.')}
              </Text>
              <Button mt="lg" variant="light" onClick={() => navigate('/settings')}>
                {t('Dream 설정 보기')}
              </Button>
            </Card>
            {nextCursor && (
              <Group justify="center">
                <Button variant="light" loading={loadingMore} onClick={() => void load(nextCursor)}>
                  {t('이전 Dream 더 불러오기')}
                </Button>
              </Group>
            )}
          </Stack>
        ) : (
          <>
            <Timeline color="grape" bulletSize={30} lineWidth={2}>
              {visible.map((d, index) => (
                <Timeline.Item
                  key={d.dreamId}
                  bullet={<IconMoonStars size={16} />}
                  // The date heads the first dream of its day and nothing after
                  // it. Every item used to carry its own: measured with a full
                  // page loaded, twenty-nine headings for two distinct days, so
                  // the one thing a timeline is for — seeing where one day ends
                  // and the next begins — was the one thing it could not show.
                  title={index > 0 && days[index - 1] === days[index] ? undefined : days[index]}
                >
                  <Card
                    id={`dream-${d.dreamId}`}
                    data-dream-id={d.dreamId}
                    mt="sm"
                    p={{ base: 'md', sm: 'xl' }}
                    radius="lg"
                    withBorder
                    className={`dream-review-card ${params.get('focus') === d.dreamId ? 'dream-review-card-focused' : ''}`}
                  >
                    <Group justify="space-between" align="flex-start">
                      <Group gap="xs">
                        <Badge color="grape" variant="light">
                          {t(typeLabels[d.type] || d.type)}
                        </Badge>
                        {/* The label is a server-supplied Korean value, so the
                            colour check stays on the original and only the
                            rendered text is translated. */}
                        <Badge color={d.qualityLabel === wellSourcedLabel ? 'green' : 'blue'} variant="light">
                          {t(d.qualityLabel)}
                        </Badge>
                        {d.generation > 1 && (
                          <Badge color="gray" variant="light">
                            {t('다른 관점 {generation}', { generation: d.generation })}
                          </Badge>
                        )}
                      </Group>
                      <Text size="xs" c="dimmed">
                        {d.spaceName}
                      </Text>
                    </Group>
                    <Text fz="lg" fw={600} lh={1.75} mt="md" style={{ whiteSpace: 'pre-wrap' }}>
                      {d.content}
                    </Text>
                    {d.rationale && (
                      <Paper mt="md" p="md" radius="md" bg="gray.0">
                        <Group gap="xs">
                          <IconRoute size={16} color="#765c96" />
                          <Text size="sm" fw={650}>
                            {t('왜 이 Dream인가요?')}
                          </Text>
                        </Group>
                        <Text size="sm" c="dimmed" mt={6}>
                          {d.rationale}
                        </Text>
                      </Paper>
                    )}
                    {d.sources.length > 0 && (
                      <SimpleGrid cols={{ base: 1, sm: 2 }} mt="sm">
                        {d.sources
                          .filter((source) => source.cited)
                          .slice(0, 4)
                          .map((source) => (
                            <button
                              type="button"
                              className="dream-source"
                              key={source.noteId}
                              onClick={() => navigate(`/space/${d.spaceId}?note=${source.noteId}`)}
                            >
                              <Text size="xs" fw={700} c="grape.7">
                                {t('원본 생각 {rank}', { rank: source.rank })}
                              </Text>
                              <Text size="sm" lineClamp={2} ta="left" mt={3}>
                                {source.title || source.excerpt}
                              </Text>
                              <Text size="xs" c="dimmed" mt={5}>
                                {t('캔버스에서 보기 →')}
                              </Text>
                            </button>
                          ))}
                      </SimpleGrid>
                    )}
                    {d.suggestedAction && (
                      <Group gap="xs" mt="md" align="flex-start" wrap="nowrap">
                        <IconBulb size={17} color="#9a6a18" style={{ marginTop: 2, flex: '0 0 auto' }} />
                        <Text size="sm">
                          <b>{t('이어가기:')}</b> {d.suggestedAction}
                        </Text>
                      </Group>
                    )}
                    {d.status !== 'deleted' && (
                      <Group mt="xl" justify="space-between">
                        <Group gap="xs">
                          {!d.noteId && d.status !== 'kept' ? (
                            <Button
                              loading={busy === `accept:${d.dreamId}`}
                              leftSection={<IconSparkles size={16} />}
                              onClick={() => void accept(d)}
                            >
                              {t('캔버스에 남기기')}
                            </Button>
                          ) : (
                            <Button
                              leftSection={<IconArrowRight size={16} />}
                              onClick={() => navigate(`/space/${d.spaceId}?note=${d.noteId || ''}`)}
                            >
                              {t('생각 곁에서 보기')}
                            </Button>
                          )}
                          <Menu shadow="md">
                            <Menu.Target>
                              <Button
                                variant="light"
                                loading={busy === `develop:${d.dreamId}`}
                                leftSection={<IconBrain size={16} />}
                              >
                                {t('발전시키기')}
                              </Button>
                            </Menu.Target>
                            <Menu.Dropdown>
                              {developModes.map(([mode, label]) => (
                                <Menu.Item key={mode} onClick={() => void develop(d, mode)}>
                                  {t(label)}
                                </Menu.Item>
                              ))}
                            </Menu.Dropdown>
                          </Menu>
                        </Group>
                        {!d.noteId && d.status !== 'kept' && (
                          <Group gap="xs">
                            <Button
                              variant="subtle"
                              loading={busy === `regenerate:${d.dreamId}`}
                              leftSection={<IconWand size={16} />}
                              onClick={() => void regenerate(d)}
                            >
                              {t('다른 관점')}
                            </Button>
                            <Menu shadow="md">
                              <Menu.Target>
                                <Button color="gray" variant="subtle" leftSection={<IconEyeOff size={16} />}>
                                  {t('숨기기')}
                                </Button>
                              </Menu.Target>
                              <Menu.Dropdown>
                                {hideReasons.map(([reason, label]) => (
                                  <Menu.Item color="red" key={reason} onClick={() => void hide(d, reason)}>
                                    {t(label)}
                                  </Menu.Item>
                                ))}
                              </Menu.Dropdown>
                            </Menu>
                          </Group>
                        )}
                      </Group>
                    )}
                    {d.status === 'deleted' && (
                      <Text mt="md" size="sm" c="dimmed">
                        {t('숨긴 Dream · 선호도 학습에 반영됨')}
                      </Text>
                    )}
                  </Card>
                </Timeline.Item>
              ))}
            </Timeline>
            {nextCursor && (
              <Group justify="center">
                <Button variant="light" loading={loadingMore} onClick={() => void load(nextCursor)}>
                  {t('이전 Dream 더 불러오기')}
                </Button>
              </Group>
            )}
          </>
        )}
      </Stack>
      <Modal
        opened={!!developed}
        onClose={() => setDeveloped(undefined)}
        title={t('Dream을 한 단계 발전시켰습니다')}
        centered
        size="lg"
      >
        <Stack>
          <Paper p="lg" radius="lg" bg="grape.0">
            <Text lh={1.75} style={{ whiteSpace: 'pre-wrap' }}>
              {developed?.result.content}
            </Text>
          </Paper>
          <Group justify="flex-end">
            <Button variant="light" onClick={() => setDeveloped(undefined)}>
              {t('그대로 두기')}
            </Button>
            <Button
              loading={!!developed && busy === `develop:${developed.dream.dreamId}`}
              onClick={() => void keepDeveloped()}
            >
              {t('이 결과를 캔버스에 남기기')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </div>
  );
}
