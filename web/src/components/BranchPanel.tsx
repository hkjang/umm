import { useState } from 'react';
import { ActionIcon, Badge, Button, Group, Menu, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { IconDots, IconGitBranch } from '@tabler/icons-react';
import { api, json } from '../api';
import { useTranslation } from '../i18n';
import { showError } from '../ui-notifications';

export interface Branch {
  id: string;
  spaceId: string;
  rootNoteId?: string;
  name: string;
  status: 'open' | 'adopted' | 'abandoned';
  resolution: string;
  resolvedAt?: string;
  notes: number;
}

/**
 * Lines of thinking, and what became of them.
 *
 * A thought that was tried and set aside comes back from search looking exactly
 * like a current one. That is the problem this solves — not clutter, but acting
 * on the option you already rejected, having forgotten you rejected it.
 *
 * Nothing here is inferred. A line is named by the person and resolved by the
 * person, and resolving it requires saying why: the decision without the reason
 * is the half people actually lose.
 */
export default function BranchPanel({
  spaceId,
  noteId,
  branches,
  assignments,
  onChanged,
  onFocus,
  readOnly = false,
}: {
  spaceId: string;
  noteId?: string;
  // Loaded by the canvas rather than here, because a thought in a line that was
  // set aside has to be marked whether or not anyone has selected it.
  branches: Branch[];
  assignments: Record<string, string>;
  /*
   * Everything here writes: filing a thought into a line, adopting one,
   * setting one aside, reopening it, deleting it, starting a new one. A member
   * shared in to read is refused all of them by the server, and the panel used
   * to offer every one regardless.
   *
   * What they keep is the part worth keeping: which line a thought belongs to
   * and what became of it, reason and all. Not being able to change it is no
   * reason to be shown less.
   */
  readOnly?: boolean;
  onChanged: () => void;
  onFocus?: (label: string, noteIds: string[]) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [resolving, setResolving] = useState<{ branch: Branch; status: 'adopted' | 'abandoned' }>();
  const [reason, setReason] = useState('');

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await api<Branch>(`/spaces/${spaceId}/branches`, json('POST', { name: trimmed, rootNoteId: noteId ?? null }));
      setName('');
      onChanged();
    } catch (reason_) {
      showError(reason_ instanceof Error ? reason_.message : t('갈래를 만들 수 없습니다.'));
    } finally {
      setBusy(false);
    }
  };

  const fileNote = async (branchId: string | null) => {
    if (!noteId) return;
    try {
      await api(`/notes/${noteId}/branch`, json('PUT', { branchId }));
      onChanged();
    } catch (reason_) {
      showError(reason_ instanceof Error ? reason_.message : t('생각을 갈래에 넣을 수 없습니다.'));
    }
  };

  const resolve = async () => {
    if (!resolving || !reason.trim()) return;
    setBusy(true);
    try {
      await api(
        `/branches/${resolving.branch.id}/resolve`,
        json('POST', { status: resolving.status, resolution: reason.trim() }),
      );
      setResolving(undefined);
      setReason('');
      onChanged();
    } catch (reason_) {
      showError(reason_ instanceof Error ? reason_.message : t('갈래를 정리할 수 없습니다.'));
    } finally {
      setBusy(false);
    }
  };

  const act = async (branch: Branch, action: 'reopen' | 'delete') => {
    try {
      await (action === 'reopen'
        ? api(`/branches/${branch.id}/reopen`, json('POST', {}))
        : api(`/branches/${branch.id}`, { method: 'DELETE' }));
      onChanged();
    } catch (reason_) {
      showError(reason_ instanceof Error ? reason_.message : t('갈래를 바꿀 수 없습니다.'));
    }
  };

  const current = noteId ? assignments[noteId] : undefined;

  return (
    <>
      <Group gap={6} mt="md">
        <IconGitBranch size={14} />
        <Text size="xs" fw={700} c="indigo.7">
          {t('생각의 갈래')}
        </Text>
      </Group>

      {branches.length === 0 && (
        <Text size="xs" c="dimmed" mt={4}>
          {t('시도해 본 방향을 갈래로 묶어 두면, 접어 둔 생각이 나중에 현재 방침처럼 읽히지 않습니다.')}
        </Text>
      )}

      <Stack gap={6} mt="xs">
        {branches.map((branch) => (
          <Group key={branch.id} gap={6} wrap="nowrap" justify="space-between">
            <Group gap={6} wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
              <Badge
                size="xs"
                variant={current === branch.id ? 'filled' : 'light'}
                color={branch.status === 'abandoned' ? 'gray' : branch.status === 'adopted' ? 'teal' : 'indigo'}
                style={{ cursor: noteId && !readOnly ? 'pointer' : 'default', flexShrink: 0 }}
                onClick={() => !readOnly && noteId && void fileNote(current === branch.id ? null : branch.id)}
                title={branch.status === 'open' ? undefined : t('이유: {reason}', { reason: branch.resolution })}
              >
                {branch.status === 'abandoned' ? t('접어 둠') : branch.status === 'adopted' ? t('채택') : t('진행 중')}
              </Badge>
              <Text size="xs" lineClamp={1} style={{ minWidth: 0 }}>
                {branch.name}
              </Text>
              <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                {branch.notes}
              </Text>
            </Group>
            {!readOnly && (
              <Menu position="bottom-end" withinPortal>
                <Menu.Target>
                  <ActionIcon size="sm" variant="subtle" aria-label={t('갈래 메뉴')}>
                    <IconDots size={14} />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  {onFocus && (
                    <Menu.Item
                      onClick={() =>
                        onFocus(
                          branch.name,
                          Object.entries(assignments)
                            .filter(([, id]) => id === branch.id)
                            .map(([note]) => note),
                        )
                      }
                    >
                      {t('이 갈래만 보기')}
                    </Menu.Item>
                  )}
                  {branch.status === 'open' ? (
                    <>
                      <Menu.Item onClick={() => setResolving({ branch, status: 'adopted' })}>
                        {t('이 방향으로 정함')}
                      </Menu.Item>
                      <Menu.Item onClick={() => setResolving({ branch, status: 'abandoned' })}>
                        {t('접어 두기')}
                      </Menu.Item>
                    </>
                  ) : (
                    <Menu.Item onClick={() => void act(branch, 'reopen')}>{t('다시 열기')}</Menu.Item>
                  )}
                  <Menu.Item color="red" onClick={() => void act(branch, 'delete')}>
                    {t('갈래만 지우기 (생각은 남습니다)')}
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            )}
          </Group>
        ))}
      </Stack>

      {resolving && (
        <Stack gap={6} mt="xs">
          <Text size="xs" c="dimmed">
            {resolving.status === 'adopted'
              ? t('왜 이 방향으로 정했는지 적어 주세요.')
              : t('왜 접어 두는지 적어 주세요. 이유가 없으면 나중에 결정만 남고 까닭은 사라집니다.')}
          </Text>
          <Textarea
            autosize
            minRows={2}
            size="xs"
            value={reason}
            aria-label={t('갈래를 정리하는 이유')}
            onChange={(e) => setReason(e.currentTarget.value)}
          />
          <Group gap={6}>
            <Button size="xs" loading={busy} disabled={!reason.trim()} onClick={() => void resolve()}>
              {t('남기기')}
            </Button>
            <Button
              size="xs"
              variant="subtle"
              color="gray"
              onClick={() => {
                setResolving(undefined);
                setReason('');
              }}
            >
              {t('취소')}
            </Button>
          </Group>
        </Stack>
      )}

      {!readOnly && (
        <Group gap={6} mt="xs" wrap="nowrap">
          <TextInput
            size="xs"
            style={{ flex: 1 }}
            placeholder={t('새 갈래 이름')}
            aria-label={t('새 갈래 이름')}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void create();
            }}
          />
          <Button size="xs" variant="light" loading={busy} disabled={!name.trim()} onClick={() => void create()}>
            {t('만들기')}
          </Button>
        </Group>
      )}
    </>
  );
}
