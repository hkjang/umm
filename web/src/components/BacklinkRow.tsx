import { ActionIcon, Button, Group, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { IconCheck, IconPencil, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { api, json, type ThoughtEdge } from '../api';
import { useTranslation } from '../i18n';
import { originLabel, relationLabel } from '../lib/edge-vocabulary';

/**
 * One connection into or out of this thought, and why it was drawn.
 *
 * The relation says what kind of connection it is. Nothing else said why, and
 * six months later that is the question people actually have — the `why` is the
 * half of a decision that disappears first.
 *
 * It is written here rather than while the line is being drawn on purpose. At
 * the moment someone drags a connection they usually cannot say why yet: two
 * thoughts look like they belong together and the reason arrives afterwards. A
 * field that only appears during the gesture would either interrupt it or fill
 * up with sentences written to satisfy a prompt.
 */
export const maxEdgeReason = 200;

interface Props {
  edge: ThoughtEdge;
  title: string;
  direction: 'incoming' | 'outgoing';
  /** Brings the connected thought into view. */
  onFocus: () => void;
  /** Somebody who may only look must not be able to annotate the space. */
  readOnly: boolean;
  onSaved: (edge: ThoughtEdge) => void;
}

export default function BacklinkRow({ edge, title, direction, onFocus, readOnly, onSaved }: Props) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(edge.reason ?? '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const saved = await api<ThoughtEdge>(`/edges/${edge.id}/reason`, json('PUT', { reason: draft.trim() }));
      onSaved(saved);
      setEditing(false);
    } catch {
      // The message is already on screen from the API layer. Staying in the
      // editor keeps what they typed rather than throwing it away.
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack gap={2}>
      <button className="related-row" onClick={onFocus}>
        <Text lineClamp={2} ta="left">
          {title}
        </Text>
        <Text size="xs" c="dimmed" ta="left">
          {direction === 'incoming' ? t('이 생각을 가리킴') : t('이 생각이 가리킴')} · {relationLabel(edge.relation)}
          {edge.origin && edge.origin !== 'manual' && ` · ${originLabel(edge.origin)}`}
        </Text>
      </button>

      {editing ? (
        <Group gap={4} wrap="nowrap" pl={12}>
          <TextInput
            size="xs"
            flex={1}
            autoFocus
            value={draft}
            maxLength={maxEdgeReason}
            placeholder={t('왜 이었는지 한 줄')}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void save();
              if (event.key === 'Escape') {
                setDraft(edge.reason ?? '');
                setEditing(false);
              }
            }}
          />
          <ActionIcon size="sm" variant="subtle" loading={saving} aria-label={t('저장')} onClick={() => void save()}>
            <IconCheck size={14} />
          </ActionIcon>
          <ActionIcon
            size="sm"
            variant="subtle"
            aria-label={t('취소')}
            onClick={() => {
              setDraft(edge.reason ?? '');
              setEditing(false);
            }}
          >
            <IconX size={14} />
          </ActionIcon>
        </Group>
      ) : (
        /* No reason is the normal state and is shown as nothing at all. An
           empty connection is not an incomplete one, and a placeholder saying
           so would turn most of somebody's graph into a list of chores. */
        <Group gap={4} wrap="nowrap" pl={12}>
          {edge.reason ? (
            <Text size="xs" c="dimmed" style={{ flex: 1 }}>
              {t('왜')}: {edge.reason}
            </Text>
          ) : (
            !readOnly && (
              <Button
                size="compact-xs"
                variant="subtle"
                color="gray"
                leftSection={<IconPencil size={12} />}
                onClick={() => setEditing(true)}
              >
                {t('왜 이었는지 적기')}
              </Button>
            )
          )}
          {edge.reason && !readOnly && (
            <Tooltip label={t('왜 이었는지 고치기')}>
              <ActionIcon
                size="sm"
                variant="subtle"
                color="gray"
                aria-label={t('왜 이었는지 고치기')}
                onClick={() => setEditing(true)}
              >
                <IconPencil size={12} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      )}
    </Stack>
  );
}
