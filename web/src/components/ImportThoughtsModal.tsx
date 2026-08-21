import { Alert, Button, FileInput, Group, Modal, Progress, Stack, Text, Textarea } from '@mantine/core';
import { IconFileImport, IconUpload } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { useTranslation } from '../i18n';
import { maxImportedThoughts, splitMarkdownThoughts, type ImportedThought } from '../lib/markdown-import';

interface Props {
  opened: boolean;
  onClose: () => void;
  onImport: (thoughts: ImportedThought[], onProgress: (done: number) => void) => Promise<number>;
}

/**
 * Brings existing notes into a canvas.
 *
 * umm could export Markdown from the start but had no way back in, which made
 * the first ten minutes of the product an empty canvas. Files and pasted text
 * go through the same splitter, so what the preview count promises is exactly
 * what gets created.
 */
export default function ImportThoughtsModal({ opened, onClose, onImport }: Props) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [error, setError] = useState('');

  const thoughts = useMemo(() => splitMarkdownThoughts(text), [text]);

  const readFiles = async (files: File[] | null) => {
    if (!files || files.length === 0) return;
    setError('');
    const contents = await Promise.all(files.map((file) => file.text()));
    // Separating files with a rule keeps each one from merging into the next.
    setText((current) => [current, ...contents].filter(Boolean).join('\n\n---\n\n'));
  };

  const run = async () => {
    setBusy(true);
    setError('');
    setDone(0);
    try {
      const created = await onImport(thoughts, setDone);
      setText('');
      onClose();
      return created;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('가져올 생각을 찾지 못했습니다.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={opened} onClose={busy ? () => undefined : onClose} title={t('마크다운 가져오기')} centered size="lg">
      <Stack>
        <Text c="dimmed" size="sm">
          {t('마크다운 파일이나 텍스트를 붙여넣으면 각 항목이 하나의 생각으로 캔버스에 붙습니다.')}
        </Text>
        <FileInput
          multiple
          clearable
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          label={t('파일 선택')}
          placeholder="notes.md"
          leftSection={<IconUpload size={16} />}
          disabled={busy}
          onChange={(files) => void readFiles(files as File[] | null)}
        />
        <Textarea
          label={t('가져올 내용')}
          description={t('# 제목이나 --- 구분선, 빈 줄 두 개로 생각을 나눕니다.')}
          autosize
          minRows={6}
          maxRows={14}
          disabled={busy}
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
        />
        {error && <Alert color="red">{error}</Alert>}
        {busy && <Progress value={thoughts.length ? (done / thoughts.length) * 100 : 0} striped animated />}
        <Group justify="space-between">
          <Text size="sm" c="dimmed">
            {busy
              ? t('가져오는 중 {done}/{total}', { done, total: thoughts.length })
              : t('{count}개의 생각을 가져옵니다.', { count: Math.min(thoughts.length, maxImportedThoughts) })}
          </Text>
          <Button
            leftSection={<IconFileImport size={17} />}
            loading={busy}
            disabled={thoughts.length === 0}
            onClick={() => void run()}
          >
            {t('가져오기')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
