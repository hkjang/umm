import { useState } from 'react';
import { ActionIcon, Group, Textarea, Tooltip } from '@mantine/core';
import { IconArrowRight, IconInbox } from '@tabler/icons-react';
import { api, json, type ThoughtNote } from '../api';
import { useTranslation } from '../i18n';
import { showError, showSuccess } from '../ui-notifications';

/**
 * Capture, available from every screen.
 *
 * A thought arrives before you know where it belongs. Asking for a space first
 * means the thought waits while you decide, and a thought that waits usually
 * gets written down somewhere else instead. This takes no space: the thought
 * lands in the inbox and the question of where it goes is answered later, or
 * never.
 */
export default function CaptureBox() {
  const { t } = useTranslation();
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);

  const capture = async () => {
    const text = content.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await api<ThoughtNote>('/capture', { ...json('POST', { content: text }), queueIfOffline: true });
      // Clearing only after the write means a failure leaves the thought in the
      // box rather than losing it, which is the whole promise of capture.
      setContent('');
      showSuccess(t('수집함에 담았습니다.'), t('생각 기록'));
    } catch {
      showError(t('생각을 저장하지 못했습니다. 입력한 내용은 그대로 두었습니다.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Group gap={6} wrap="nowrap" className="capture-box" visibleFrom="sm">
      <Textarea
        aria-label={t('무슨 생각을 하고 있나요?')}
        placeholder={t('무슨 생각을 하고 있나요?')}
        value={content}
        onChange={(e) => setContent(e.currentTarget.value)}
        onKeyDown={(e) => {
          // Enter sends, so a one-line thought costs one keystroke to keep.
          // Shift+Enter is how you write more than one line.
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void capture();
          }
        }}
        autosize
        minRows={1}
        maxRows={4}
        w={260}
        size="sm"
        leftSection={<IconInbox size={16} />}
      />
      <Tooltip label={t('수집함에 담기')}>
        <ActionIcon
          variant="filled"
          color="grape"
          size="lg"
          loading={busy}
          disabled={!content.trim()}
          onClick={() => void capture()}
          aria-label={t('수집함에 담기')}
        >
          <IconArrowRight size={18} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}
