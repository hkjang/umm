import { useState } from 'react';
import { Alert, Badge, Button, Card, Group, Stack, Text, Title, UnstyledButton } from '@mantine/core';
import { IconArrowsJoin, IconMoon } from '@tabler/icons-react';
import { api, json, type MergeResult, type MorningBrief } from '../api';
import { msg, useTranslation } from '../i18n';
import { showSuccess } from '../ui-notifications';

const dreamKindLabels: Record<string, string> = {
  connection: msg('연결'),
  question: msg('질문'),
  expansion: msg('확장'),
  contrarian: msg('반론'),
  rediscovery: msg('재발견'),
  action: msg('실행'),
  pattern: msg('패턴'),
  free: msg('자유'),
};

/**
 * What accumulated while you were away.
 *
 * Only things umm actually produced appear here. It would be easy to add a row
 * for contradictions or for thoughts whose importance rose overnight — but umm
 * detects neither, and a zero beside a category it never examined reads as
 * "there are none" rather than "nobody looked".
 *
 * For the same reason, anything umm could not check is stated rather than left
 * as an absence.
 */
export default function MorningBriefCard({
  brief,
  onOpen,
}: {
  brief: MorningBrief;
  onOpen: (spaceId?: string, noteId?: string) => void;
}) {
  const { t } = useTranslation();
  const dreamTotal = brief.dreams.reduce((sum, group) => sum + group.count, 0);
  // Pairs already dealt with, so the list shrinks as it is worked through
  // instead of asking again about something just answered.
  const [handled, setHandled] = useState<string[]>([]);
  const [merging, setMerging] = useState('');

  // Reporting duplicates without a way to act on them leaves a list of problems
  // and no button. The older note survives — it is the original thought, and
  // whatever already points at it keeps pointing somewhere real.
  const merge = async (pairKey: string, keepID: string, mergeID: string, content: string) => {
    setMerging(pairKey);
    try {
      const result = await api<MergeResult>(`/notes/${keepID}/merge`, json('POST', { mergeId: mergeID, content }));
      setHandled((all) => [...all, pairKey]);
      showSuccess(
        result.movedEdges > 0
          ? t('하나로 합쳤습니다. 연결 {count}개도 함께 옮겼습니다.', { count: result.movedEdges })
          : t('하나로 합쳤습니다.'),
        t('생각 정리'),
      );
    } finally {
      setMerging('');
    }
  };

  const pending = brief.duplicates.filter((pair) => !handled.includes(`${pair.first.id}-${pair.second.id}`));

  return (
    <Card className="brief-card" radius="xl" p={{ base: 'lg', sm: 'xl' }} withBorder>
      <Group gap="sm">
        <IconMoon size={20} stroke={1.6} />
        <Title order={2} fz="lg">
          {t('지난밤 umm이 살펴본 것')}
        </Title>
      </Group>

      <Group gap="lg" mt="md" wrap="wrap">
        {dreamTotal > 0 && (
          <div>
            <Text fz="xl" fw={700}>
              {dreamTotal}
            </Text>
            <Text size="xs" c="dimmed">
              {t('읽지 않은 Dream')}
            </Text>
            <Group gap={4} mt={4}>
              {brief.dreams.map((group) => (
                <Badge key={group.kind} size="xs" variant="light" color="grape">
                  {t(dreamKindLabels[group.kind] ?? group.kind)} {group.count}
                </Badge>
              ))}
            </Group>
          </div>
        )}
        {brief.suggestions > 0 && (
          <div>
            <Text fz="xl" fw={700}>
              {brief.suggestions}
            </Text>
            <Text size="xs" c="dimmed">
              {t('검토 대기 중인 추천 연결')}
            </Text>
          </div>
        )}
        {brief.unfiled > 0 && (
          <div>
            <Text fz="xl" fw={700}>
              {brief.unfiled}
            </Text>
            <Text size="xs" c="dimmed">
              {t('아직 정리하지 않은 생각')}
            </Text>
          </div>
        )}
        {brief.questions.length > 0 && (
          <div>
            <Text fz="xl" fw={700}>
              {brief.questions.length}
            </Text>
            <Text size="xs" c="dimmed">
              {t('답을 못 찾은 질문')}
            </Text>
          </div>
        )}
        {brief.questions.length > 0 && (
          <Stack gap={6} mt="md">
            <Text size="xs" fw={700} c="blue.7">
              {t('질문으로 표시해 둔 것')}
            </Text>
            {brief.questions.slice(0, 3).map((item) => (
              <UnstyledButton
                key={item.note.id}
                className="brief-duplicate"
                onClick={() => onOpen(item.spaceId, item.note.id)}
              >
                <Text size="xs" c="dimmed">
                  {item.space}
                  {/* A question nobody has touched and one argued over at length
                    are different situations, so the count is shown when there is
                    one rather than left implicit. */}
                  {item.attempts > 0 && ` · ${t('관련 생각 {count}개', { count: item.attempts })}`}
                </Text>
                <Text size="sm" lineClamp={2}>
                  {item.note.title || item.note.content}
                </Text>
              </UnstyledButton>
            ))}
          </Stack>
        )}

        {brief.contradictions.length > 0 && (
          <div>
            <Text fz="xl" fw={700}>
              {brief.contradictions.length}
            </Text>
            <Text size="xs" c="dimmed">
              {t('기록해 둔 상충')}
            </Text>
          </div>
        )}
        {pending.length > 0 && (
          <div>
            <Text fz="xl" fw={700}>
              {pending.length}
            </Text>
            <Text size="xs" c="dimmed">
              {t('겹쳐 보이는 생각')}
            </Text>
          </div>
        )}
      </Group>

      {pending.length > 0 && (
        <Stack gap={6} mt="md">
          {pending.slice(0, 3).map((pair) => {
            const pairKey = `${pair.first.id}-${pair.second.id}`;
            // The older thought survives. Which of the two that is comes from
            // creation order, not from which one umm happened to list first.
            const [older, newer] =
              pair.first.createdAt <= pair.second.createdAt ? [pair.first, pair.second] : [pair.second, pair.first];
            // One side sits in a line that was decided against. Merging is not
            // offered here: the older thought survives a merge, so one click
            // would fold what is being written now into a line someone already
            // rejected — quietly, and with the wrong thought left standing.
            // What is useful is the decision and the reason for it.
            if (pair.setAside) {
              return (
                <Stack key={pairKey} gap={2}>
                  <UnstyledButton
                    className="brief-duplicate"
                    onClick={() => onOpen(pair.spaceId, pair.setAsideNoteId ?? older.id)}
                  >
                    <Text size="xs" fw={700} c="orange.7">
                      {t('접어 둔 갈래를 다시 쓰고 있습니다 · {line}', { line: pair.setAside.name })}
                    </Text>
                    <Text size="sm" lineClamp={1}>
                      {newer.title || newer.content}
                    </Text>
                    {pair.setAside.resolution && (
                      <Text size="xs" c="dimmed" lineClamp={2}>
                        {t('접어 둔 이유: {reason}', { reason: pair.setAside.resolution })}
                      </Text>
                    )}
                  </UnstyledButton>
                </Stack>
              );
            }
            return (
              <Group key={pairKey} gap="sm" wrap="nowrap" align="flex-start">
                <UnstyledButton
                  className="brief-duplicate"
                  style={{ flex: 1, minWidth: 0 }}
                  onClick={() => onOpen(pair.spaceId, older.id)}
                >
                  <Text size="xs" c="dimmed">
                    {pair.space} · {Math.round(pair.score * 100)}%
                  </Text>
                  <Text size="sm" lineClamp={1}>
                    {older.title || older.content}
                  </Text>
                  <Text size="sm" lineClamp={1} c="dimmed">
                    {newer.title || newer.content}
                  </Text>
                </UnstyledButton>
                <Button
                  size="compact-xs"
                  variant="light"
                  leftSection={<IconArrowsJoin size={13} />}
                  loading={merging === pairKey}
                  onClick={() => void merge(pairKey, older.id, newer.id, older.content)}
                >
                  {t('하나로 합치기')}
                </Button>
              </Group>
            );
          })}
          <Text size="xs" c="dimmed">
            {t('먼저 적은 쪽이 남고, 연결과 댓글은 따라옵니다. 문구를 고르려면 생각을 열어 직접 정리하세요.')}
          </Text>
        </Stack>
      )}

      {brief.contradictions.length > 0 && (
        <Stack gap={6} mt="md">
          <Text size="xs" fw={700} c="red.7">
            {t('서로 안 맞는다고 표시해 둔 것')}
          </Text>
          {brief.contradictions.slice(0, 3).map((item) => (
            <UnstyledButton
              key={item.edgeId}
              className="brief-duplicate"
              onClick={() => onOpen(item.spaceId, item.claim.id)}
            >
              <Text size="xs" c="dimmed">
                {item.space}
              </Text>
              <Text size="sm" lineClamp={1}>
                {item.claim.title || item.claim.content}
              </Text>
              <Text size="sm" lineClamp={1} c="dimmed">
                ↔ {item.counter.title || item.counter.content}
              </Text>
            </UnstyledButton>
          ))}
        </Stack>
      )}

      {brief.skipped.map((skip) => (
        <Alert key={skip.kind} color="gray" variant="light" mt="md">
          {skip.reason === 'backend-not-semantic'
            ? t(
                '겹치는 생각은 확인하지 못했습니다. 지금 임베딩은 뜻이 아니라 단어 겹침을 재기 때문에, 찾아 봤자 표현이 비슷한 것만 나옵니다.',
              )
            : skip.reason === 'space-too-large'
              ? t('공간이 커서 최근 생각까지만 비교했습니다. 겹치는 것이 더 있을 수 있습니다.')
              : t('겹치는 생각 확인이 꺼져 있습니다.')}
        </Alert>
      ))}
    </Card>
  );
}
