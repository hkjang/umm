import { useState, type FormEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  Divider,
  Group,
  Menu,
  Paper,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconAlertCircle, IconArrowRight, IconLanguage, IconMoonStars } from '@tabler/icons-react';
import { api, json } from '../api';
import { useAuth } from '../auth-context';
import AppearanceMenu from '../components/AppearanceMenu';
import { useTranslation } from '../i18n';

export default function LoginPage() {
  const { meta, refresh } = useAuth();
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api('/auth/login', { ...json('POST', { username, password }), silent: true });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('로그인하지 못했습니다.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-page">
      <section className="login-scene" aria-hidden="true">
        <Box pos="absolute" top="11%" left="10%" style={{ zIndex: 2 }}>
          <div className="brand-mark" style={{ width: 50, height: 50, fontSize: 20 }}>
            um
          </div>
          <Title order={1} mt="lg" fz={42} fw={720} c="var(--ink)" style={{ letterSpacing: '-.04em' }}>
            {t('생각부터 붙이세요.')}
          </Title>
          <Text fz="lg" c="dimmed" mt="sm">
            {t('정리는 나중에. 연결과 성장은 자연스럽게.')}
          </Text>
        </Box>
        <div
          className="login-note"
          style={{ left: '17%', top: '43%', background: '#fff0a8', transform: 'rotate(-2deg)' }}
        >
          {t('오늘 떠오른 생각은')}
          <br />
          {t('여기에 가볍게.')}
        </div>
        <div
          className="login-note"
          style={{ right: '11%', top: '29%', background: '#dbeeff', transform: 'rotate(1.5deg)' }}
        >
          {t('관련된 생각들이')}
          <br />
          {t('서로를 발견합니다.')}
        </div>
        <div
          className="login-note"
          style={{ right: '22%', bottom: '12%', background: '#e8e2f1', transform: 'rotate(-1deg)' }}
        >
          <Text size="xs" tt="uppercase" fw={700} c="grape.7" mb="xs">
            Dream
          </Text>
          {t('밤사이 생각 하나가')}
          <br />
          {t('자라날지도 몰라요.')}
        </div>
      </section>
      <section className="login-form-side">
        <Paper component="form" onSubmit={submit} w="100%" maw={390} bg="transparent" p="md">
          <Stack gap="lg">
            <div>
              <Title order={2} fz={30} style={{ letterSpacing: '-.03em' }}>
                {t('다시 생각할 시간이에요')}
              </Title>
              <Text c="dimmed" mt={8}>
                {t('나의 Thought Space로 들어갑니다.')}
              </Text>
            </div>
            {error && (
              <Alert icon={<IconAlertCircle size={18} />} color="red" variant="light">
                {error}
              </Alert>
            )}
            <TextInput
              label={t('아이디')}
              value={username}
              onChange={(e) => setUsername(e.currentTarget.value)}
              size="lg"
              autoComplete="username"
              required
              autoFocus
            />
            <PasswordInput
              label={t('비밀번호')}
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              size="lg"
              autoComplete="current-password"
              required
            />
            <Button type="submit" size="lg" rightSection={<IconArrowRight size={18} />} loading={busy}>
              {t('로그인')}
            </Button>
            {meta?.oidcEnabled && (
              <>
                <Divider label={t('또는')} />
                <Button component="a" href="/api/v1/auth/oidc/start" variant="light" color="dark" size="lg">
                  {t('Keycloak SSO로 계속')}
                </Button>
              </>
            )}
            <Group justify="center" gap="xs">
              <Menu shadow="md" width={230} position="top">
                <Menu.Target>
                  <Button variant="subtle" color="gray" size="compact-sm" leftSection={<IconLanguage size={15} />}>
                    {t('언어 선택')}
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  <AppearanceMenu />
                </Menu.Dropdown>
              </Menu>
            </Group>
            <Text ta="center" size="sm" c="dimmed">
              <IconMoonStars size={14} style={{ verticalAlign: '-2px' }} /> {meta?.serviceName || 'umm'} · v
              {meta?.version || 'dev'}
            </Text>
          </Stack>
        </Paper>
      </section>
    </main>
  );
}
