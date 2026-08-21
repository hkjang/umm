import { Badge, Button, Card, Divider, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { IconDeviceLaptop, IconLogout } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useTranslation } from '../i18n';
import { showSuccess } from '../ui-notifications';

interface Session {
  id: string;
  userAgent: string;
  clientIp: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

/**
 * describeAgent turns a user agent into something a person can recognise. It is
 * intentionally coarse: the goal is "is this the laptop I am holding?", not
 * accurate device fingerprinting.
 */
function describeAgent(agent: string, unknown: string) {
  const trimmed = agent.trim();
  if (!trimmed) return unknown;
  const browser = /Edg\//.test(trimmed)
    ? 'Edge'
    : /OPR\//.test(trimmed)
      ? 'Opera'
      : /Chrome\//.test(trimmed)
        ? 'Chrome'
        : /Safari\//.test(trimmed)
          ? 'Safari'
          : /Firefox\//.test(trimmed)
            ? 'Firefox'
            : '';
  const platform = /Android/.test(trimmed)
    ? 'Android'
    : /iPhone|iPad|iOS/.test(trimmed)
      ? 'iOS'
      : /Mac OS X|Macintosh/.test(trimmed)
        ? 'macOS'
        : /Windows/.test(trimmed)
          ? 'Windows'
          : /Linux/.test(trimmed)
            ? 'Linux'
            : '';
  const parts = [browser, platform].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : trimmed.slice(0, 60);
}

/** Active browser sessions, with the ability to end any of them. */
export default function SessionsCard() {
  const { t, formatDate } = useTranslation();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [busy, setBusy] = useState('');

  const load = () =>
    api<{ sessions: Session[] }>('/sessions', { silent: true })
      .then((value) => setSessions(value.sessions))
      .catch(() => setSessions([]));

  useEffect(() => {
    void load();
  }, []);

  const revoke = async (session: Session) => {
    setBusy(session.id);
    try {
      await api(`/sessions/${session.id}`, { method: 'DELETE' });
      // Ending the current session signs this browser out, so the app has to
      // start over rather than keep rendering behind a dead cookie.
      if (session.current) {
        window.location.assign('/');
        return;
      }
      await load();
    } finally {
      setBusy('');
    }
  };

  const revokeOthers = async () => {
    if (!window.confirm(t('다른 기기의 로그인을 모두 종료할까요?'))) return;
    setBusy('others');
    try {
      const result = await api<{ revoked: number }>('/sessions/revoke-others', { method: 'POST' });
      showSuccess(t('{count}개의 다른 로그인을 종료했습니다.', { count: result.revoked }), t('로그인한 기기'));
      await load();
    } finally {
      setBusy('');
    }
  };

  const others = sessions.filter((session) => !session.current);

  return (
    <Card radius="lg" p="xl" withBorder>
      <Group justify="space-between">
        <Group>
          <IconDeviceLaptop />
          <div>
            <Title order={2} fz="xl">
              {t('로그인한 기기')}
            </Title>
            <Text c="dimmed" mt={4}>
              {t('이 브라우저 외의 다른 로그인을 확인하고 즉시 종료할 수 있습니다.')}
            </Text>
          </div>
        </Group>
        <Button
          variant="light"
          color="red"
          leftSection={<IconLogout size={17} />}
          disabled={others.length === 0}
          loading={busy === 'others'}
          onClick={() => void revokeOthers()}
        >
          {t('다른 기기 모두 로그아웃')}
        </Button>
      </Group>
      <Divider my="lg" />
      {sessions.length <= 1 ? (
        <Text c="dimmed">{t('로그인 기기가 이 브라우저뿐입니다.')}</Text>
      ) : (
        <Stack gap="sm">
          {sessions.map((session) => (
            <Paper key={session.id} p="md" radius="md" withBorder>
              <Group justify="space-between" align="flex-start">
                <div>
                  <Group gap="xs">
                    <Text fw={650}>{describeAgent(session.userAgent, t('알 수 없는 기기'))}</Text>
                    {session.current && (
                      <Badge color="grape" variant="light">
                        {t('현재 기기')}
                      </Badge>
                    )}
                  </Group>
                  <Text size="xs" c="dimmed" mt={4}>
                    {session.clientIp} · {t('마지막 활동')} {formatDate(session.lastSeenAt)}
                  </Text>
                </div>
                <Button
                  size="xs"
                  variant="subtle"
                  color="red"
                  loading={busy === session.id}
                  onClick={() => void revoke(session)}
                >
                  {t('로그인 종료')}
                </Button>
              </Group>
            </Paper>
          ))}
        </Stack>
      )}
    </Card>
  );
}
