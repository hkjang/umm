import { Button, Group, Paper, Text } from '@mantine/core';
import { IconCloudOff, IconGitMerge, IconRefresh } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { flushOfflineQueue, offlineConflictCount, offlineQueueCount, replayOfflineConflicts } from '../api';
import { useTranslation } from '../i18n';

/**
 * The floating banner that reports queued offline changes.
 *
 * It listens for the browser's connectivity events and for the queue's own
 * change event, so the count stays correct whether a mutation was queued by
 * this screen or another one.
 *
 * A change can also be stuck for a reason connecting will not fix: its version
 * conflicts with what the server already has, and only the reader can say which
 * text wins. Those are counted apart, because syncing skips them — telling
 * someone their change waits for a connection, next to a button that does
 * nothing, is the one thing this banner must not do.
 */
export default function OfflineStatus() {
  const { t } = useTranslation();
  const [online, setOnline] = useState(() => navigator.onLine);
  const [queued, setQueued] = useState(() => offlineQueueCount());
  const [conflicts, setConflicts] = useState(() => offlineConflictCount());
  const [syncing, setSyncing] = useState(false);

  const sync = async () => {
    setSyncing(true);
    try {
      const result = await flushOfflineQueue();
      setQueued(result.remaining);
      setConflicts(offlineConflictCount());
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    const update = () => {
      setOnline(navigator.onLine);
      setQueued(offlineQueueCount());
      setConflicts(offlineConflictCount());
    };
    const reconnected = () => {
      update();
      if (navigator.onLine) void sync();
    };
    const counted = () => {
      setQueued(offlineQueueCount());
      setConflicts(offlineConflictCount());
    };
    window.addEventListener('online', reconnected);
    window.addEventListener('offline', update);
    window.addEventListener('umm:offline-queue', counted);
    window.addEventListener('umm:offline-conflict', counted);
    if (navigator.onLine && offlineQueueCount() > 0) void sync();
    return () => {
      window.removeEventListener('online', reconnected);
      window.removeEventListener('offline', update);
      window.removeEventListener('umm:offline-queue', counted);
      window.removeEventListener('umm:offline-conflict', counted);
    };
  }, []);

  if (online && queued === 0) return null;
  // A conflict is only held while its change is queued, but the two counts are
  // read at different moments, so the smaller one is the honest number.
  const deciding = Math.min(conflicts, queued);
  const sendable = queued - deciding;
  return (
    <Paper className="network-status" role="status" aria-live="polite" shadow="md" radius="xl" px="md" py="xs">
      <Group gap="xs" wrap="nowrap">
        {!online ? (
          <IconCloudOff size={17} />
        ) : deciding > 0 && !syncing ? (
          <IconGitMerge size={17} />
        ) : (
          <IconRefresh className={syncing ? 'spin' : ''} size={17} />
        )}
        <Text size="sm" fw={650}>
          {online
            ? syncing
              ? t('오프라인 변경 동기화 중')
              : deciding > 0
                ? t('{count}개 변경이 겹침 해결을 기다리는 중', { count: deciding })
                : t('{count}개 변경이 연결을 기다리는 중', { count: queued })
            : t('오프라인 · {count}개 변경을 안전하게 보관 중', { count: queued })}
        </Text>
        {online && deciding > 0 && !syncing && (
          <Button size="compact-xs" variant="subtle" onClick={() => replayOfflineConflicts()}>
            {t('겹침 확인')}
          </Button>
        )}
        {online && sendable > 0 && !syncing && (
          <Button size="compact-xs" variant="subtle" onClick={() => void sync()}>
            {t('지금 동기화')}
          </Button>
        )}
      </Group>
    </Paper>
  );
}
