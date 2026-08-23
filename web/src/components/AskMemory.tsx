import { useState } from 'react';
import { Alert, Button, Card, Group, Stack, Text, TextInput, Title, UnstyledButton } from '@mantine/core';
import { IconSearch, IconSparkles } from '@tabler/icons-react';
import { api, json } from '../api';
import { useTranslation } from '../i18n';
import { showError } from '../ui-notifications';

interface AskSource {
  ref: number;
  noteId: string;
  spaceId: string;
  content: string;
  via: 'match' | 'connection';
}

interface AskAnswer {
  answer: string;
  sources: AskSource[];
  excluded: number;
  grounded: boolean;
}

/**
 * Asking your own memory.
 *
 * The answer is built only from thoughts already written down, and the sources
 * are shown beside it — a claim with no citation is meant to be visible as one.
 *
 * When nothing matched, umm says so rather than answering anyway. That is the
 * case where an ungrounded answer would be most convincing and most wrong.
 */
export default function AskMemory({ onOpen }: { onOpen: (spaceId?: string, noteId?: string) => void }) {
  const { t } = useTranslation();
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AskAnswer>();

  const ask = async () => {
    const text = question.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      setResult(await api<AskAnswer>('/ai/ask', json('POST', { question: text })));
    } catch (reason) {
      setResult(undefined);
      showError(reason instanceof Error ? reason.message : t('기억에서 답을 찾지 못했습니다.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="ask-card" radius="xl" p={{ base: 'lg', sm: 'xl' }} withBorder>
      <Group gap="sm" mb="sm">
        <IconSparkles size={20} stroke={1.6} />
        <Title order={2} fz="lg">
          {t('내 기억에 물어보기')}
        </Title>
      </Group>
      <Group gap="xs" wrap="nowrap">
        <TextInput
          style={{ flex: 1 }}
          placeholder={t('예: 인증 토큰 만료를 얼마로 정했더라')}
          aria-label={t('내 기억에 물어보기')}
          leftSection={<IconSearch size={16} />}
          value={question}
          onChange={(e) => setQuestion(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) void ask();
          }}
        />
        <Button loading={busy} disabled={!question.trim()} onClick={() => void ask()}>
          {t('묻기')}
        </Button>
      </Group>

      {result && !result.grounded && (
        <Alert color="gray" variant="light" mt="md">
          {t('이 질문에 답할 만한 생각을 찾지 못했습니다. 지어내지 않고 그대로 말씀드립니다.')}
        </Alert>
      )}

      {result?.grounded && (
        <Stack gap="xs" mt="md">
          <Text style={{ whiteSpace: 'pre-wrap' }}>{result.answer}</Text>
          <Text size="xs" fw={700} c="dimmed" mt={4}>
            {t('근거로 삼은 생각')}
          </Text>
          {result.sources.map((source) => (
            <UnstyledButton
              key={source.noteId}
              className="brief-duplicate"
              onClick={() => onOpen(source.spaceId, source.noteId)}
            >
              <Text size="xs" c="dimmed">
                [{source.ref}] {source.via === 'match' ? t('질문과 일치') : t('연결을 따라 도달')}
              </Text>
              <Text size="sm" lineClamp={2}>
                {source.content}
              </Text>
            </UnstyledButton>
          ))}
          {result.excluded > 0 && (
            <Text size="xs" c="dimmed">
              {t('AI 제외로 표시된 생각 {count}개는 답에 쓰이지 않았습니다.', { count: result.excluded })}
            </Text>
          )}
        </Stack>
      )}
    </Card>
  );
}
