import { Indicator, Menu, Text, UnstyledButton } from '@mantine/core';
import { IconBell } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useTranslation } from '../i18n';

export interface AppNotification {
  id: string;
  title: string;
  body: string;
  resourceType?: string;
  resourceId?: string;
  resourceSpaceId?: string;
  readAt?: string;
}

/** Deep link for a notification, or an empty string when it has no target. */
export function notificationTarget(item: AppNotification) {
  if (!item.resourceId) return '';
  if (item.resourceType === 'dream') return `/dreams?focus=${encodeURIComponent(item.resourceId)}`;
  if (item.resourceType === 'space') return `/space/${encodeURIComponent(item.resourceId)}`;
  if (item.resourceType === 'note' && item.resourceSpaceId)
    return `/space/${encodeURIComponent(item.resourceSpaceId)}?note=${encodeURIComponent(item.resourceId)}`;
  return '';
}

const pollIntervalMs = 60_000;

export default function NotificationMenu() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);

  const load = () =>
    api<{ notifications: AppNotification[]; unread: number }>('/notifications', { silent: true })
      .then((value) => {
        setNotifications(value.notifications);
        setUnread(value.unread);
      })
      .catch(() => undefined);

  useEffect(() => {
    void load();
    const timer = window.setInterval(load, pollIntervalMs);
    return () => window.clearInterval(timer);
  }, []);

  const open = async (item: AppNotification) => {
    if (!item.readAt)
      await api(`/notifications/${item.id}/read`, { method: 'POST', silent: true }).catch(() => undefined);
    void load();
    const target = notificationTarget(item);
    if (target) navigate(target);
  };

  return (
    <Menu shadow="md" width={330} position="bottom-end">
      <Menu.Target>
        <Indicator disabled={unread === 0} label={unread > 9 ? '9+' : unread} size={17} color="grape">
          <UnstyledButton className="header-icon-button" aria-label={t('알림 {count}개', { count: unread })}>
            <IconBell size={22} />
          </UnstyledButton>
        </Indicator>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{t('알림')}</Menu.Label>
        {notifications.length === 0 ? (
          <Menu.Item disabled>{t('새 알림이 없습니다.')}</Menu.Item>
        ) : (
          notifications.slice(0, 8).map((item) => (
            <Menu.Item key={item.id} bg={!item.readAt ? 'grape.0' : undefined} onClick={() => void open(item)}>
              <Text size="sm" fw={!item.readAt ? 650 : 500}>
                {item.title}
              </Text>
              <Text size="xs" c="dimmed" lineClamp={2}>
                {item.body}
              </Text>
            </Menu.Item>
          ))
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
