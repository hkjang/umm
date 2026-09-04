import { Alert, Badge, Card, Group, SegmentedControl, Stack, Table, Text, Title } from '@mantine/core';
import { IconRobot } from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useTranslation } from '../i18n';

/**
 * What your own thoughts were sent to an AI model for.
 *
 * umm goes to some trouble to let someone hold a note back from analysis, hold
 * a whole space back, and keep note bodies off an embedding gateway. All of
 * that is a promise, and this is where a person checks it for themselves —
 * until now only an administrator could see any of it.
 *
 * The screen is written around the two ways it could lie. An empty list reads
 * as "nothing happened" when it can equally mean the log was cleaned up, so the
 * retention window is always on screen. And a list of chat-model calls reads as
 * the whole story when indexing sends note bodies too, so the current policy is
 * stated next to the list rather than left to be assumed.
 */

interface Entry {
  at: string;
  /** Empty on calls recorded before v0.67.0: not recorded, not unknown. */
  purpose: string;
  model: string;
  status: 'success' | 'failed';
  inputTokens: number;
  outputTokens: number;
}

interface Usage {
  entries: Entry[] | null;
  counts: Record<string, number> | null;
  total: number;
  truncated: boolean;
  retentionDays: number;
}

interface Answer {
  usage: Usage;
  since: string;
  days: number;
  embeddingsLeaveThisMachine: boolean;
  embeddingModel: string;
}

export default function AIUsageCard() {
  const { t } = useTranslation();
  const [days, setDays] = useState('30');
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [loading, setLoading] = useState(true);

  /** What each call was for, in the words a person would use. */
  const purposeLabel = (purpose: string) =>
    ({
      dream: t('Dream 생성'),
      assist: t('AI Assist'),
      ask: t('기억에 질문'),
      agent: t('살펴보고 답하기'),
      develop: t('Dream 발전'),
      'deck-headings': t('덱 묶음 제목'),
      'deck-sections': t('덱 부 나누기'),
    })[purpose] ?? t('기록되지 않음');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setAnswer(await api<Answer>(`/ai-usage?days=${days}`));
    } catch {
      // The API layer has already said so on screen. Leaving the card empty
      // beats showing a list that is not the person's record.
      setAnswer(null);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  const usage = answer?.usage;
  const entries = usage?.entries ?? [];
  const counts = usage?.counts ?? {};

  return (
    <Card radius="lg" p="xl" withBorder>
      <Group justify="space-between" align="flex-start">
        <Group gap="sm">
          <IconRobot size={22} />
          <div>
            <Title order={2} fz="xl">
              {t('내 AI 사용 내역')}
            </Title>
            <Text size="sm" c="dimmed">
              {t('내 생각이 언제, 무엇을 위해 AI 모델로 갔는지입니다.')}
            </Text>
          </div>
        </Group>
        <SegmentedControl
          size="xs"
          value={days}
          onChange={setDays}
          data={[
            { value: '7', label: t('{count}일', { count: 7 }) },
            { value: '30', label: t('{count}일', { count: 30 }) },
            { value: '90', label: t('{count}일', { count: 90 }) },
          ]}
        />
      </Group>

      {/* The policy, stated rather than implied. Indexing sends note bodies in
          batches that can span several people's notes in a shared space, so
          naming one person for one batch would be a guess — the policy is a
          fact, and it is the thing someone actually wants to know. */}
      <Alert mt="md" variant="light" color={answer?.embeddingsLeaveThisMachine ? 'yellow' : 'green'}>
        <Text size="sm">
          {answer?.embeddingsLeaveThisMachine
            ? t(
                '이 설치는 검색·연결을 위해 메모 본문을 임베딩 게이트웨이({model})로 보냅니다. 그 호출은 여러 사람의 메모가 한 번에 묶여 나가므로 아래 목록에는 없습니다.',
                {
                  model: answer.embeddingModel,
                },
              )
            : t('메모 본문은 임베딩을 위해 이 서버 밖으로 나가지 않습니다. 검색과 연결은 로컬에서 계산합니다.')}
        </Text>
        <Text size="xs" c="dimmed" mt={4}>
          {t('AI 제외로 표시한 메모와 공간은 아래 호출에도 들어가지 않습니다.')}
        </Text>
      </Alert>

      {Object.keys(counts).length > 0 && (
        <Group gap="xs" mt="md">
          {Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .map(([purpose, count]) => (
              <Badge key={purpose || 'unrecorded'} variant="light" color={purpose ? 'blue' : 'gray'}>
                {purposeLabel(purpose)} {count}
              </Badge>
            ))}
        </Group>
      )}

      <Stack gap={6} mt="md">
        {loading && <Text c="dimmed">{t('불러오는 중입니다…')}</Text>}
        {!loading && entries.length === 0 && (
          /* Not "you have used no AI". The log is cleaned up on a schedule, so
             an empty list is only ever a statement about the window. */
          <Text c="dimmed">
            {t(
              '최근 {days}일 동안 기록된 호출이 없습니다. 기록은 {retention}일 뒤 삭제되므로, 그보다 오래된 일은 여기에 남지 않습니다.',
              {
                days: answer?.days ?? Number(days),
                retention: usage?.retentionDays ?? 90,
              },
            )}
          </Text>
        )}
        {entries.length > 0 && (
          <Table striped highlightOnHover fz="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('시각')}</Table.Th>
                <Table.Th>{t('무엇을 위해')}</Table.Th>
                <Table.Th>{t('모델')}</Table.Th>
                <Table.Th>{t('결과')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {entries.map((entry, index) => (
                <Table.Tr key={`${entry.at}-${index}`}>
                  <Table.Td>{new Date(entry.at).toLocaleString()}</Table.Td>
                  <Table.Td>{purposeLabel(entry.purpose)}</Table.Td>
                  <Table.Td>
                    <Text size="xs" c="dimmed">
                      {entry.model}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    {/* A failed call still sent the prompt, so it is listed and
                        says so rather than being hidden as a non-event. */}
                    <Badge size="sm" variant="light" color={entry.status === 'failed' ? 'red' : 'gray'}>
                      {entry.status === 'failed' ? t('실패') : t('성공')}
                    </Badge>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
        {usage?.truncated && (
          <Text size="xs" c="dimmed">
            {t('이 기간에 호출이 {total}번 있었고, 그중 최근 {shown}번만 표시했습니다.', {
              total: usage.total,
              shown: entries.length,
            })}
          </Text>
        )}
        {entries.length > 0 && (
          <Text size="xs" c="dimmed">
            {t('기록은 {retention}일 뒤 삭제됩니다.', { retention: usage?.retentionDays ?? 90 })}
          </Text>
        )}
      </Stack>
    </Card>
  );
}
