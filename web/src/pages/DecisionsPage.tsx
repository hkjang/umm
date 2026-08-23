import { useEffect, useState } from 'react';
import { Alert, Badge, Card, Group, Loader, Stack, Text, Title, UnstyledButton } from '@mantine/core';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useTranslation } from '../i18n';

interface TurningPoint {
  kind: 'adopted' | 'abandoned' | 'answered' | 'contradicted';
  at: string;
  spaceId: string;
  space: string;
  subject: string;
  detail: string;
  noteId?: string;
}

/**
 * What changed in your thinking, in the order it changed.
 *
 * Six months later the question is rarely "what did I write" but "what did we
 * decide about this, and why". The reason is the part that goes missing first,
 * so it is shown beside the decision rather than a click away.
 *
 * Everything here was marked by a person. Nothing is inferred from activity,
 * and an empty page means nothing was marked — not that nothing happened. The
 * page says so, because a record that looks complete when it is not is worse
 * than one that admits what it covers.
 */
export default function DecisionsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [points, setPoints] = useState<TurningPoint[]>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api<{ points: TurningPoint[] }>('/turning-points')
      .then((result) => setPoints(result.points))
      .catch(() => setFailed(true));
  }, []);

  const label = (kind: TurningPoint['kind']) => {
    if (kind === 'adopted') return t('이 방향으로 정함');
    if (kind === 'abandoned') return t('접어 둠');
    if (kind === 'answered') return t('답을 찾음');
    return t('상충을 표시함');
  };
  const colour = (kind: TurningPoint['kind']) =>
    kind === 'adopted' ? 'teal' : kind === 'abandoned' ? 'gray' : kind === 'answered' ? 'blue' : 'orange';
  const detailLead = (kind: TurningPoint['kind']) => {
    if (kind === 'adopted' || kind === 'abandoned') return t('이유');
    if (kind === 'answered') return t('답');
    return t('반대편');
  };

  return (
    <Stack gap="md" p={{ base: 'md', sm: 'xl' }}>
      <div>
        <Title order={1} fz="xl">
          {t('결정 기록')}
        </Title>
        <Text size="sm" c="dimmed">
          {t('직접 표시한 것만 남습니다. 활동이 많았다는 이유로 전환점을 지어내지 않습니다.')}
        </Text>
      </div>

      {failed && (
        <Alert color="red" variant="light">
          {t('기록을 불러오지 못했습니다.')}
        </Alert>
      )}

      {!points && !failed && <Loader size="sm" />}

      {points?.length === 0 && (
        <Alert color="gray" variant="light">
          {t('아직 표시한 결정이 없습니다. 표시된 것이 없다는 뜻이지, 아무 일도 없었다는 뜻은 아닙니다.')}
        </Alert>
      )}

      <Stack gap="xs">
        {points?.map((point, index) => (
          <Card key={`${point.at}-${index}`} withBorder radius="md" padding="md">
            <Group gap="xs" mb={6} wrap="nowrap">
              <Badge size="sm" color={colour(point.kind)} variant="light">
                {label(point.kind)}
              </Badge>
              <Text size="xs" c="dimmed">
                {new Date(point.at).toLocaleDateString()} · {point.space}
              </Text>
            </Group>
            {point.noteId ? (
              <UnstyledButton onClick={() => navigate(`/space/${point.spaceId}?note=${point.noteId}`)}>
                <Text fw={600} lineClamp={2} ta="left">
                  {point.subject}
                </Text>
              </UnstyledButton>
            ) : (
              <Text fw={600} lineClamp={2}>
                {point.subject}
              </Text>
            )}
            {point.detail && (
              <Text size="sm" c="dimmed" mt={4}>
                {detailLead(point.kind)}: {point.detail}
              </Text>
            )}
          </Card>
        ))}
      </Stack>
    </Stack>
  );
}
