import { Button, Group, Paper, Text } from '@mantine/core';
import { IconCloudOff, IconRefresh } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { flushOfflineQueue, offlineQueueCount } from '../api';
import { useTranslation } from '../i18n';

/**
 * The floating banner that reports queued offline changes.
 *
 * It listens for the browser's connectivity events and for the queue's own
 * change event, so the count stays correct whether a mutation was queued by
 * this screen or another one.
 */
export default function OfflineStatus() {
  const { t } = useTranslation();
  const [online, setOnline] = useState(() => navigator.onLine);
  const [queued, setQueued] = useState(() => offlineQueueCount());
  const [syncing, setSyncing] = useState(false);

  const sync = async () => {
    setSyncing(true);
    try {
      const result = await flushOfflineQueue();
      setQueued(result.remaining);
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    const update = () => {
      setOnline(navigator.onLine);
      setQueued(offlineQueueCount());
    };
    const reconnected = () => {
      update();
      if (navigator.onLine) void sync();
    };
    const queueChanged = () => setQueued(offlineQueueCount());
    window.addEventListener('online', reconnected);
    window.addEventListener('offline', update);
    window.addEventListener('umm:offline-queue', queueChanged);
    if (navigator.onLine && offlineQueueCount() > 0) void sync();
    return () => {
      window.removeEventListener('online', reconnected);
      window.removeEventListener('offline', update);
      window.removeEventListener('umm:offline-queue', queueChanged);
    };
  }, []);

  if (online && queued === 0) return null;
  return (
    <Paper className="network-status" role="status" aria-live="polite" shadow="md" radius="xl" px="md" py="xs">
      <Group gap="xs" wrap="nowrap">
        {online ? <IconRefresh className={syncing ? 'spin' : ''} size={17} /> : <IconCloudOff size={17} />}
        <Text size="sm" fw={650}>
          {online
            ? syncing
              ? t('오프라인 변경 동기화 중')
              : t('{count}개 변경이 연결을 기다리는 중', { count: queued })
            : t('오프라인 · {count}개 변경을 안전하게 보관 중', { count: queued })}
        </Text>
        {online && queued > 0 && !syncing && (
          <Button size="compact-xs" variant="subtle" onClick={() => void sync()}>
            {t('지금 동기화')}
          </Button>
        )}
      </Group>
    </Paper>
  );
}
