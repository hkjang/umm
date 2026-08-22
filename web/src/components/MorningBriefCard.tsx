import { Alert, Badge, Card, Group, Stack, Text, Title, UnstyledButton } from '@mantine/core';
import { IconMoon } from '@tabler/icons-react';
import type { MorningBrief } from '../api';
import { msg, useTranslation } from '../i18n';

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
        {brief.duplicates.length > 0 && (
          <div>
            <Text fz="xl" fw={700}>
              {brief.duplicates.length}
            </Text>
            <Text size="xs" c="dimmed">
              {t('겹쳐 보이는 생각')}
            </Text>
          </div>
        )}
      </Group>

      {brief.duplicates.length > 0 && (
        <Stack gap={6} mt="md">
          {brief.duplicates.slice(0, 3).map((pair) => (
            <UnstyledButton
              key={`${pair.first.id}-${pair.second.id}`}
              className="brief-duplicate"
              onClick={() => onOpen(pair.spaceId, pair.first.id)}
            >
              <Text size="xs" c="dimmed">
                {pair.space} · {Math.round(pair.score * 100)}%
              </Text>
              <Text size="sm" lineClamp={1}>
                {pair.first.title || pair.first.content}
              </Text>
              <Text size="sm" lineClamp={1} c="dimmed">
                {pair.second.title || pair.second.content}
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
            : t('겹치는 생각 확인이 꺼져 있습니다.')}
        </Alert>
      ))}
    </Card>
  );
}
