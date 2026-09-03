import { Button, Group, Paper, Text } from '@mantine/core';
import { IconCloudOff, IconGitMerge, IconLock, IconRefresh } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import {
  flushOfflineQueue,
  offlineBlockReason,
  offlineConflictCount,
  offlineQueueCount,
  replayOfflineConflicts,
} from '../api';
import { useAuth } from '../auth-context';
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
 *
 * A session that ended is the third such reason, and the flush reports it here
 * rather than leaving the queue to look like a slow network. Signing in again is
 * the only thing that moves those changes, so that is what the banner offers:
 * re-reading the session takes the app to the login screen when it really has
 * gone, and leaves everything as it is when it has not.
 */
export default function OfflineStatus() {
  const { t } = useTranslation();
  const { refresh } = useAuth();
  const [online, setOnline] = useState(() => navigator.onLine);
  const [queued, setQueued] = useState(() => offlineQueueCount());
  const [conflicts, setConflicts] = useState(() => offlineConflictCount());
  const [blocked, setBlocked] = useState(() => offlineBlockReason());
  const [syncing, setSyncing] = useState(false);

  const sync = async () => {
    setSyncing(true);
    try {
      const result = await flushOfflineQueue();
      setQueued(result.remaining);
      setConflicts(offlineConflictCount());
      setBlocked(offlineBlockReason());
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    const update = () => {
      setOnline(navigator.onLine);
      setQueued(offlineQueueCount());
      setConflicts(offlineConflictCount());
      setBlocked(offlineBlockReason());
    };
    const reconnected = () => {
      update();
      if (navigator.onLine) void sync();
    };
    const counted = () => {
      setQueued(offlineQueueCount());
      setConflicts(offlineConflictCount());
      setBlocked(offlineBlockReason());
    };
    window.addEventListener('online', reconnected);
    window.addEventListener('offline', update);
    window.addEventListener('umm:offline-queue', counted);
    window.addEventListener('umm:offline-conflict', counted);
    // Flushes also run from the retry timer and from other screens, and their
    // verdict is the one this banner reports. Without this the reason a queue
    // is stuck would only ever appear after a sync started from here.
    window.addEventListener('umm:offline-sync', counted);
    if (navigator.onLine && offlineQueueCount() > 0) void sync();
    return () => {
      window.removeEventListener('online', reconnected);
      window.removeEventListener('offline', update);
      window.removeEventListener('umm:offline-queue', counted);
      window.removeEventListener('umm:offline-conflict', counted);
      window.removeEventListener('umm:offline-sync', counted);
    };
  }, []);

  if (online && queued === 0) return null;
  // A conflict is only held while its change is queued, but the two counts are
  // read at different moments, so the smaller one is the honest number.
  const deciding = Math.min(conflicts, queued);
  // A halted flush stopped the whole queue, so nothing here is merely waiting to
  // be sent, and offering to send it would be the same empty button all over
  // again.
  const halted = online && !syncing ? blocked : undefined;
  const sendable = halted ? 0 : queued - deciding;
  return (
    <Paper className="network-status" role="status" aria-live="polite" shadow="md" radius="xl" px="md" py="xs">
      <Group gap="xs" wrap="nowrap">
        {!online ? (
          <IconCloudOff size={17} />
        ) : halted ? (
          <IconLock size={17} />
        ) : deciding > 0 && !syncing ? (
          <IconGitMerge size={17} />
        ) : (
          <IconRefresh className={syncing ? 'spin' : ''} size={17} />
        )}
        <Text size="sm" fw={650}>
          {online
            ? syncing
              ? t('오프라인 변경 동기화 중')
              : halted === 'signed-out'
                ? t('{count}개 변경이 다시 로그인하기를 기다리는 중', { count: queued })
                : halted === 'refused'
                  ? t('{count}개 변경을 지금 계정으로 보낼 수 없음', { count: queued })
                  : deciding > 0
                    ? t('{count}개 변경이 겹침 해결을 기다리는 중', { count: deciding })
                    : t('{count}개 변경이 연결을 기다리는 중', { count: queued })
            : t('오프라인 · {count}개 변경을 안전하게 보관 중', { count: queued })}
        </Text>
        {halted === 'signed-out' && (
          <Button size="compact-xs" variant="subtle" onClick={() => void refresh()}>
            {t('다시 로그인')}
          </Button>
        )}
        {halted === 'refused' && (
          <Button size="compact-xs" variant="subtle" onClick={() => void sync()}>
            {t('다시 시도')}
          </Button>
        )}
        {online && deciding > 0 && !syncing && !halted && (
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
