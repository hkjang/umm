import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Paper,
  Progress,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import {
  IconArrowRight,
  IconBell,
  IconCheck,
  IconClock,
  IconLink,
  IconMessageCircle,
  IconMoonStars,
  IconPin,
  IconSparkles,
} from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, json, type Space } from '../api';
import { useTranslation } from '../i18n';
import { showSuccess } from '../ui-notifications';

interface ReviewItem {
  id: string;
  spaceId: string;
  spaceName: string;
  title: string;
  content: string;
  pinned: boolean;
  updatedAt: string;
  reason: string;
}
interface ReviewDream {
  id: string;
  spaceId: string;
  spaceName: string;
  content: string;
  rationale: string;
  suggestedAction: string;
  generatedAt: string;
}
interface Activity {
  id: string;
  noteId: string;
  spaceId: string;
  spaceName: string;
  author: string;
  body: string;
  createdAt: string;
}
interface OnboardingStep {
  key: string;
  label: string;
  description: string;
  done: boolean;
  target: string;
}
interface TodayData {
  review: ReviewItem[];
  orphans: ReviewItem[];
  dreams: ReviewDream[];
  activity: Activity[];
  onboarding: { completedAt?: string; percent: number; steps: OnboardingStep[] };
  counts: Record<string, number>;
}

const excerpt = (value: string, fallback: string) => value.replace(/\s+/g, ' ').trim().slice(0, 180) || fallback;

export default function TodayPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [data, setData] = useState<TodayData>();
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => {
    setError('');
    try {
      const [today, spaceData] = await Promise.all([api<TodayData>('/today'), api<{ spaces: Space[] }>('/spaces')]);
      setData(today);
      setSpaces(spaceData.spaces);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('오늘의 리뷰를 불러오지 못했습니다.'));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const openCanvas = (spaceId?: string, noteId?: string) => {
    const target = spaceId || spaces[0]?.id;
    if (target) navigate(`/space/${target}${noteId ? `?note=${encodeURIComponent(noteId)}` : ''}`);
  };
  const review = async (item: ReviewItem, snoozeDays?: number, pinned?: boolean, complete = true) => {
    setBusy(item.id);
    try {
      await api(`/notes/${item.id}/review`, json('POST', { snoozeDays, pinned, complete }));
      await load();
      showSuccess(
        !complete
          ? t(pinned ? '중요한 생각으로 고정했습니다.' : '중요 고정을 해제했습니다.')
          : snoozeDays
            ? t('{days}일 뒤에 다시 보여드릴게요.', { days: snoozeDays })
            : t('오늘의 검토를 완료했습니다.'),
        t('리뷰 정리'),
      );
    } finally {
      setBusy('');
    }
  };
  const complete = async () => {
    await api('/onboarding/complete', { method: 'POST' });
    await load();
  };
  const summaries = data
    ? [
        { label: t('다시 볼 생각'), value: data.counts.review || 0, Icon: IconClock, color: 'grape' },
        { label: t('연결 대기'), value: data.counts.orphans || 0, Icon: IconLink, color: 'blue' },
        { label: t('새 Dream'), value: data.counts.dreams || 0, Icon: IconMoonStars, color: 'violet' },
        { label: t('함께한 활동'), value: data.counts.activity || 0, Icon: IconBell, color: 'orange' },
      ]
    : [];
  if (!data && !error)
    return (
      <main className="today-page">
        <Loader color="grape" />
      </main>
    );
  return (
    <main className="today-page">
      <Stack maw={1180} mx="auto" gap="xl">
        <Group justify="space-between" align="flex-end">
          <div>
            <Text size="xs" c="grape.7" fw={750}>
              DAILY REVIEW
            </Text>
            <Title order={1} mt={4}>
              {t('오늘, 이어볼 생각')}
            </Title>
            <Text c="dimmed" mt={6}>
              {t('새로운 신호와 오래된 생각을 한 자리에서 가볍게 검토합니다.')}
            </Text>
          </div>
          <Button leftSection={<IconSparkles size={17} />} onClick={() => openCanvas()}>
            {t('생각 붙이기')}
          </Button>
        </Group>
        {error && (
          <Alert color="red" title={t('리뷰를 불러오지 못했습니다.')}>
            {error}
            <Button variant="subtle" mt="sm" onClick={() => void load()}>
              {t('다시 시도')}
            </Button>
          </Alert>
        )}
        {data && (
          <>
            {!data.onboarding.completedAt && (
              <Card className="onboarding-card" radius="xl" p={{ base: 'lg', sm: 'xl' }} withBorder>
                <Group justify="space-between" align="flex-start">
                  <div>
                    <Badge color="grape" variant="light">
                      {t('시작 안내')}
                    </Badge>
                    <Title order={2} fz="xl" mt="sm">
                      {t('umm을 내 생각 습관에 연결하기')}
                    </Title>
                    <Text c="dimmed" mt={4}>
                      {t('실제 기능을 한 번씩 써보며 익히는 짧은 안내입니다.')}
                    </Text>
                  </div>
                  <ThemeIcon size={48} radius="xl" color="grape" variant="light">
                    <IconSparkles />
                  </ThemeIcon>
                </Group>
                <Progress
                  value={data.onboarding.percent}
                  color="grape"
                  mt="xl"
                  size="sm"
                  aria-label={t('온보딩 {percent}% 완료', { percent: data.onboarding.percent })}
                />
                <SimpleGrid cols={{ base: 1, sm: 2 }} mt="lg">
                  {data.onboarding.steps.map((step) => (
                    <button
                      type="button"
                      className="onboarding-step"
                      data-done={step.done || undefined}
                      key={step.key}
                      onClick={() => (step.key === 'collaborate' ? navigate('/dreams') : openCanvas())}
                    >
                      <ThemeIcon color={step.done ? 'green' : 'gray'} variant="light" radius="xl">
                        {step.done ? <IconCheck size={17} /> : <IconArrowRight size={17} />}
                      </ThemeIcon>
                      <div>
                        <Text fw={650} ta="left">
                          {step.label}
                        </Text>
                        <Text size="xs" c="dimmed" ta="left">
                          {step.description}
                        </Text>
                      </div>
                    </button>
                  ))}
                </SimpleGrid>
                <Group justify="flex-end" mt="lg">
                  <Button variant="subtle" color="gray" onClick={() => void complete()}>
                    {t('안내 마치기')}
                  </Button>
                </Group>
              </Card>
            )}
            <SimpleGrid cols={{ base: 2, sm: 4 }}>
              {summaries.map(({ label, value, Icon, color }) => (
                <Paper key={label} withBorder radius="lg" p="lg">
                  <Group gap="sm">
                    <ThemeIcon color={color} variant="light" radius="xl">
                      <Icon size={18} />
                    </ThemeIcon>
                    <div>
                      <Text size="xs" c="dimmed">
                        {label}
                      </Text>
                      <Text fz="xl" fw={720}>
                        {value}
                      </Text>
                    </div>
                  </Group>
                </Paper>
              ))}
            </SimpleGrid>
            <div className="today-main-grid">
              <Stack gap="xl">
                <section aria-labelledby="review-title">
                  <Group justify="space-between" mb="md">
                    <div>
                      <Title id="review-title" order={2} fz="xl">
                        {t('다시 볼 생각')}
                      </Title>
                      <Text size="sm" c="dimmed">
                        {t('오래되었거나 직접 다시 보기로 한 메모입니다.')}
                      </Text>
                    </div>
                  </Group>
                  {data.review.length === 0 ? (
                    <Empty icon={IconCheck} title={t('오늘 검토할 생각을 모두 봤어요')} />
                  ) : (
                    <Stack gap="sm">
                      {data.review.map((item) => (
                        <Card key={item.id} withBorder radius="lg" p="lg">
                          <Group justify="space-between" align="flex-start" wrap="nowrap">
                            <div>
                              <Group gap="xs">
                                <Badge variant="light" color="gray">
                                  {item.spaceName}
                                </Badge>
                                {item.pinned && <IconPin size={15} aria-label={t('고정됨')} />}
                                <Text size="xs" c="dimmed">
                                  {item.reason}
                                </Text>
                              </Group>
                              <Text fw={650} mt="sm">
                                {item.title || excerpt(item.content, t('내용 없는 생각'))}
                              </Text>
                              {item.title && (
                                <Text size="sm" c="dimmed" lineClamp={2} mt={4}>
                                  {excerpt(item.content, t('내용 없는 생각'))}
                                </Text>
                              )}
                            </div>
                            <Button size="xs" variant="subtle" onClick={() => openCanvas(item.spaceId, item.id)}>
                              {t('열기')}
                            </Button>
                          </Group>
                          <Group gap="xs" mt="md">
                            <Button
                              size="xs"
                              loading={busy === item.id}
                              leftSection={<IconCheck size={14} />}
                              onClick={() => void review(item)}
                            >
                              {t('검토 완료')}
                            </Button>
                            <Button size="xs" variant="light" onClick={() => void review(item, 7)}>
                              {t('7일 뒤')}
                            </Button>
                            <Button size="xs" variant="subtle" color="gray" onClick={() => void review(item, 30)}>
                              {t('30일 뒤')}
                            </Button>
                            <Button
                              size="xs"
                              variant="subtle"
                              color={item.pinned ? 'grape' : 'gray'}
                              leftSection={<IconPin size={14} />}
                              onClick={() => void review(item, undefined, !item.pinned, false)}
                            >
                              {t(item.pinned ? '고정 해제' : '중요 고정')}
                            </Button>
                          </Group>
                        </Card>
                      ))}
                    </Stack>
                  )}
                </section>
                <section aria-labelledby="orphan-title">
                  <Title id="orphan-title" order={2} fz="xl">
                    {t('연결을 기다리는 생각')}
                  </Title>
                  <Text size="sm" c="dimmed" mb="md">
                    {t('아직 다른 생각과 선으로 연결되지 않았습니다.')}
                  </Text>
                  {data.orphans.length === 0 ? (
                    <Empty icon={IconLink} title={t('모든 생각이 연결되어 있어요')} />
                  ) : (
                    <SimpleGrid cols={{ base: 1, sm: 2 }}>
                      {data.orphans.map((item) => (
                        <Card
                          component="button"
                          className="today-note-card"
                          key={item.id}
                          withBorder
                          radius="lg"
                          p="lg"
                          onClick={() => openCanvas(item.spaceId, item.id)}
                        >
                          <Badge variant="light" color="blue">
                            {item.spaceName}
                          </Badge>
                          <Text fw={650} mt="sm" lineClamp={2}>
                            {item.title || excerpt(item.content, t('내용 없는 생각'))}
                          </Text>
                          <Text size="xs" c="dimmed" mt="md">
                            {t('캔버스에서 연결하기 →')}
                          </Text>
                        </Card>
                      ))}
                    </SimpleGrid>
                  )}
                </section>
              </Stack>
              <Stack gap="xl">
                <section aria-labelledby="dream-title">
                  <Group justify="space-between" mb="md">
                    <div>
                      <Title id="dream-title" order={2} fz="xl">
                        {t('Dream 검토함')}
                      </Title>
                      <Text size="sm" c="dimmed">
                        {t('근거와 함께 도착한 새 관점입니다.')}
                      </Text>
                    </div>
                    <Button size="xs" variant="subtle" onClick={() => navigate('/dreams')}>
                      {t('전체')}
                    </Button>
                  </Group>
                  {data.dreams.length === 0 ? (
                    <Empty icon={IconMoonStars} title={t('새 Dream이 없습니다')} />
                  ) : (
                    <Stack gap="sm">
                      {data.dreams.map((item) => (
                        <Card key={item.id} withBorder radius="lg" p="lg" className="today-dream-card">
                          <Group gap="xs">
                            <IconMoonStars size={17} />
                            <Badge color="grape" variant="light">
                              {item.spaceName}
                            </Badge>
                          </Group>
                          <Text fw={650} lh={1.65} mt="sm" lineClamp={4}>
                            {item.content}
                          </Text>
                          {item.rationale && (
                            <Text size="xs" c="dimmed" mt="sm" lineClamp={2}>
                              {item.rationale}
                            </Text>
                          )}
                          <Button
                            fullWidth
                            mt="md"
                            variant="light"
                            onClick={() => navigate(`/dreams?focus=${item.id}`)}
                          >
                            {t('근거와 함께 검토')}
                          </Button>
                        </Card>
                      ))}
                    </Stack>
                  )}
                </section>
                <section aria-labelledby="activity-title">
                  <Title id="activity-title" order={2} fz="xl">
                    {t('함께한 활동')}
                  </Title>
                  <Text size="sm" c="dimmed" mb="md">
                    {t('공유 공간의 최근 댓글입니다.')}
                  </Text>
                  {data.activity.length === 0 ? (
                    <Empty icon={IconMessageCircle} title={t('새 협업 활동이 없습니다')} />
                  ) : (
                    <Stack gap="xs">
                      {data.activity.map((item) => (
                        <button
                          type="button"
                          className="activity-row"
                          key={item.id}
                          onClick={() => openCanvas(item.spaceId, item.noteId)}
                        >
                          <ThemeIcon color="orange" variant="light" radius="xl">
                            <IconMessageCircle size={16} />
                          </ThemeIcon>
                          <div>
                            <Text size="sm" fw={650} ta="left">
                              {item.author} · {item.spaceName}
                            </Text>
                            <Text size="xs" c="dimmed" ta="left" lineClamp={2}>
                              {item.body}
                            </Text>
                          </div>
                        </button>
                      ))}
                    </Stack>
                  )}
                </section>
              </Stack>
            </div>
          </>
        )}
      </Stack>
    </main>
  );
}

function Empty({ icon: Icon, title }: { icon: typeof IconCheck; title: string }) {
  return (
    <Paper withBorder radius="lg" p="xl" ta="center" bg="gray.0">
      <Icon size={28} color="#8c7a9f" />
      <Text fw={650} mt="sm">
        {title}
      </Text>
    </Paper>
  );
}
