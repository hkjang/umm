import { Alert, Button, FileInput, Group, Modal, Progress, Stack, Text, Textarea } from '@mantine/core';
import { IconFileImport, IconUpload } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { useTranslation } from '../i18n';
import {
  formatImportedThoughts,
  maxImportedThoughts,
  readMarkdownDocument,
  type ImportedDocument,
  type ImportThoughtsResult,
} from '../lib/markdown-import';

interface Props {
  opened: boolean;
  onClose: () => void;
  onImport: (document: ImportedDocument, onProgress: (done: number) => void) => Promise<ImportThoughtsResult>;
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

  const parsed = useMemo(() => readMarkdownDocument(text), [text]);
  const thoughts = parsed.thoughts;
  /*
   * The cap is for someone else's Markdown, not for your own space coming back.
   *
   * It exists so a large vault cannot flood a canvas in a single click — a
   * count nobody expected, from a file nobody read. An umm export is neither:
   * every thought in it was already in a umm space, and restoring it is a
   * deliberate act.
   *
   * Leaving the cap on made the backup useless exactly where a backup matters.
   * A space of two thousand notes — the size this canvas is built for — could
   * not be restored at all, and the advice the screen gave, to split the input
   * and try again, produced the worst possible result: only the first piece
   * carries the banner, so every piece after it was read as ordinary Markdown,
   * with the ids and canvas positions left in the bodies and each untitled
   * thought named "Thought".
   */
  const overLimit = !parsed.isExport && thoughts.length > maxImportedThoughts;
  const limitError = overLimit
    ? t('한 번에 최대 {max}개의 생각을 가져올 수 있습니다. 현재 {count}개입니다. 입력을 나누어 다시 시도해 주세요.', {
        max: maxImportedThoughts,
        count: thoughts.length,
      })
    : '';

  const readFiles = async (files: File[] | null) => {
    if (!files || files.length === 0) return;
    setError('');
    const contents = await Promise.all(files.map((file) => file.text()));
    // Separating files with a rule keeps each one from merging into the next.
    setText((current) => [current, ...contents].filter(Boolean).join('\n\n---\n\n'));
  };

  const run = async () => {
    if (overLimit) {
      setError(limitError);
      return 0;
    }
    setBusy(true);
    setError('');
    setDone(0);
    try {
      const result = await onImport(parsed, setDone);
      if (result.failed.length > 0) {
        setText(formatImportedThoughts(result.failed));
        setError(
          t('{count}개의 생각을 가져오지 못했습니다. 입력란에 남겨 두었으니 다시 시도해 주세요.', {
            count: result.failed.length,
          }),
        );
        setDone(0);
        return result.created;
      }
      setText('');
      onClose();
      return result.created;
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
        {(limitError || error) && <Alert color="red">{limitError || error}</Alert>}
        {busy && <Progress value={thoughts.length ? (done / thoughts.length) * 100 : 0} striped animated />}
        <Group justify="space-between">
          <Text size="sm" c="dimmed">
            {busy
              ? t('가져오는 중 {done}/{total}', { done, total: thoughts.length })
              : t('{count}개의 생각을 가져옵니다.', { count: thoughts.length })}
          </Text>
          <Button
            leftSection={<IconFileImport size={17} />}
            loading={busy}
            disabled={thoughts.length === 0 || overLimit}
            onClick={() => void run()}
          >
            {t('가져오기')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
