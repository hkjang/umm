import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Group,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Title,
  UnstyledButton,
} from '@mantine/core';
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

interface AgentStep {
  tool: string;
  input: string;
  summary: string;
}

interface AgentAnswer {
  answer: string;
  steps: AgentStep[];
  excluded: number;
  truncated: boolean;
}

/**
 * The assistant reads and never writes, so what it did can be listed plainly.
 * Showing the trail is the point: an answer arrived at by looking is only worth
 * more than a guess if you can see where it looked.
 */
function toolLabel(tool: string, t: (key: string) => string): string {
  // Written out rather than looked up in a map, because a dynamic key never
  // reaches the translation extractor and would ship untranslated.
  if (tool === 'search_thoughts') return t('생각을 검색함');
  if (tool === 'find_open_questions') return t('열린 질문을 확인함');
  if (tool === 'find_contradictions') return t('상충 표시를 확인함');
  return tool;
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
  const [mode, setMode] = useState<'ask' | 'agent'>('ask');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AskAnswer>();
  const [agentResult, setAgentResult] = useState<AgentAnswer>();

  const ask = async () => {
    const text = question.trim();
    if (!text || busy) return;
    setBusy(true);
    setResult(undefined);
    setAgentResult(undefined);
    try {
      if (mode === 'agent') {
        setAgentResult(await api<AgentAnswer>('/ai/agent', json('POST', { task: text })));
      } else {
        setResult(await api<AskAnswer>('/ai/ask', json('POST', { question: text })));
      }
    } catch (reason) {
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
      <SegmentedControl
        fullWidth
        size="xs"
        mb="xs"
        value={mode}
        onChange={(next) => {
          setMode(next as 'ask' | 'agent');
          setResult(undefined);
          setAgentResult(undefined);
        }}
        data={[
          { value: 'ask', label: t('한 번에 답하기') },
          { value: 'agent', label: t('살펴보고 답하기') },
        ]}
      />
      <Group gap="xs" wrap="nowrap">
        <TextInput
          style={{ flex: 1 }}
          placeholder={
            mode === 'agent'
              ? t('예: 최근에 미뤄 둔 결정이 뭐가 있는지 살펴봐 줘')
              : t('예: 인증 토큰 만료를 얼마로 정했더라')
          }
          aria-label={t('내 기억에 물어보기')}
          leftSection={<IconSearch size={16} />}
          value={question}
          onChange={(e) => setQuestion(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) void ask();
          }}
        />
        <Button loading={busy} disabled={!question.trim()} onClick={() => void ask()}>
          {mode === 'agent' ? t('살펴보기') : t('묻기')}
        </Button>
      </Group>

      {mode === 'agent' && !agentResult && !busy && (
        <Text size="xs" c="dimmed" mt="xs">
          {t('여러 번 찾아본 뒤 답합니다. 읽기만 하며, 아무것도 만들거나 고치지 않습니다.')}
        </Text>
      )}

      {agentResult && (
        <Stack gap="xs" mt="md">
          <Text style={{ whiteSpace: 'pre-wrap' }}>{agentResult.answer}</Text>
          {agentResult.truncated && (
            <Alert color="yellow" variant="light">
              {t('살펴볼 수 있는 횟수를 다 써서 도중에 멈췄습니다. 결론이 아니라 지금까지 확인한 범위입니다.')}
            </Alert>
          )}
          <Text size="xs" fw={700} c="dimmed" mt={4}>
            {t('살펴본 과정')}
          </Text>
          {agentResult.steps.map((step, index) => (
            <Text key={index} size="xs" c="dimmed">
              {index + 1}. {toolLabel(step.tool, t)} — {step.summary}
            </Text>
          ))}
          {agentResult.excluded > 0 && (
            <Text size="xs" c="dimmed">
              {t('AI 제외로 표시된 생각 {count}개는 답에 쓰이지 않았습니다.', { count: agentResult.excluded })}
            </Text>
          )}
        </Stack>
      )}

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
