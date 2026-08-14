import { Alert, Stack } from '@mantine/core';
import { IconAlertCircle, IconCheck, IconInfoCircle } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import type { UINotice } from '../ui-notifications';

const colors = { success: 'green', error: 'red', info: 'blue' } as const;
const icons = { success: IconCheck, error: IconAlertCircle, info: IconInfoCircle } as const;

export default function AppNotifications() {
  const [notices, setNotices] = useState<UINotice[]>([]);
  const timers = useRef(new Map<string, number>());

  const dismiss = (id: string) => {
    const timer = timers.current.get(id);
    if (timer) window.clearTimeout(timer);
    timers.current.delete(id);
    setNotices((all) => all.filter((notice) => notice.id !== id));
  };

  useEffect(() => {
    const onNotice = (event: Event) => {
      const notice = (event as CustomEvent<UINotice>).detail;
      if (!notice) return;
      const previousTimer = timers.current.get(notice.id);
      if (previousTimer) window.clearTimeout(previousTimer);
      setNotices((all) => [...all.filter((item) => item.id !== notice.id), notice].slice(-4));
      timers.current.set(notice.id, window.setTimeout(() => dismiss(notice.id), notice.timeout));
    };
    window.addEventListener('umm:notice', onNotice);
    return () => {
      window.removeEventListener('umm:notice', onNotice);
      timers.current.forEach((timer) => window.clearTimeout(timer));
      timers.current.clear();
    };
  }, []);

  return <div className="app-notifications" aria-live="polite" aria-atomic="false">
    <Stack gap="sm">{notices.map((notice) => {
      const Icon = icons[notice.tone];
      return <Alert key={notice.id} className="app-notification" color={colors[notice.tone]} title={notice.title} icon={<Icon size={19}/>} withCloseButton onClose={() => dismiss(notice.id)}>
        {notice.message}
      </Alert>;
    })}</Stack>
  </div>;
}
