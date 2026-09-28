import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Collapse,
  Group,
  Menu,
  Paper,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
  UnstyledButton,
} from '@mantine/core';
import {
  IconAlertCircle,
  IconArrowRight,
  IconChevronDown,
  IconLanguage,
  IconLockPassword,
  IconMoonStars,
  IconShieldCheck,
} from '@tabler/icons-react';
import { api, json } from '../api';
import { useAuth } from '../auth-context';
import AppearanceMenu from '../components/AppearanceMenu';
import { useTranslation } from '../i18n';
import { signInReturnTo, ssoLoginUrl } from '../lib/silent-sso';

export default function LoginPage() {
  const { meta, refresh } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // Where signing in goes next: the address that was opened, or — on /login,
  // where a refused or failed SSO attempt lands — the one it carried along.
  // Both buttons take the person there, so neither sign-in is the one that
  // forgets where they were going.
  const [returnTo] = useState(() => signInReturnTo(window.location));
  // The SSO flow lands here with ?sso=none when Keycloak had no session for a
  // silent attempt — the ordinary "not signed in there" — and ?sso=error when
  // anything else went wrong.
  const [ssoOutcome] = useState(() => new URLSearchParams(window.location.search).get('sso'));
  const [error, setError] = useState(() =>
    ssoOutcome === 'error'
      ? t('Keycloak SSO 로그인이 완료되지 않았습니다. 다시 시도하거나 아이디와 비밀번호로 로그인하세요.')
      : '',
  );
  const [busy, setBusy] = useState(false);
  // With SSO on, the organization account is the way in and the password
  // form is folded away beneath it. It opens by itself when SSO has just
  // failed, since that is exactly when the person needs the other door.
  const ssoEnabled = !!meta?.oidcEnabled;
  const [passwordOpen, setPasswordOpen] = useState(ssoOutcome === 'error');
  const passwordVisible = !ssoEnabled || passwordOpen;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api('/auth/login', { ...json('POST', { username, password }), silent: true });
      if (returnTo !== window.location.pathname + window.location.search + window.location.hash) {
        navigate(returnTo, { replace: true });
      }
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
        <Paper w="100%" maw={400} bg="transparent" p="md">
          <Stack gap="lg">
            <div>
              <Title order={2} fz={30} style={{ letterSpacing: '-.03em' }}>
                {t('다시 생각할 시간이에요')}
              </Title>
              <Text c="dimmed" mt={8}>
                {ssoEnabled
                  ? t('조직 계정으로 로그인하면 원래 보던 화면으로 돌아갑니다.')
                  : t('나의 Thought Space로 들어갑니다.')}
              </Text>
            </div>
            {ssoEnabled && ssoOutcome === 'none' && (
              <Alert icon={<IconShieldCheck size={18} />} color="gray" variant="light" role="status">
                {t('조직 계정 세션이 없어 자동으로 로그인하지 않았습니다. 아래 버튼으로 로그인하세요.')}
              </Alert>
            )}
            {error && (
              <Alert icon={<IconAlertCircle size={18} />} color="red" variant="light">
                {error}
              </Alert>
            )}
            {ssoEnabled && (
              <Button
                component="a"
                href={ssoLoginUrl(returnTo)}
                size="lg"
                fullWidth
                leftSection={<IconShieldCheck size={19} />}
              >
                {t('조직 계정으로 로그인')}
              </Button>
            )}
            {ssoEnabled && (
              <UnstyledButton
                className="local-login-toggle"
                aria-expanded={passwordOpen}
                aria-controls="password-login-form"
                onClick={() => setPasswordOpen((open) => !open)}
              >
                <IconLockPassword size={17} />
                <span>{t('아이디와 비밀번호로 로그인')}</span>
                <IconChevronDown size={17} className={passwordOpen ? 'is-open' : undefined} />
              </UnstyledButton>
            )}
            <Collapse expanded={passwordVisible} transitionDuration={ssoEnabled ? 200 : 0}>
              <form id="password-login-form" onSubmit={submit}>
                <Stack gap="lg">
                  {ssoEnabled && (
                    <Text size="sm" c="dimmed">
                      {t('조직 계정이 없거나 SSO를 쓸 수 없을 때를 위한 umm 자체 계정입니다.')}
                    </Text>
                  )}
                  <TextInput
                    label={t('아이디')}
                    value={username}
                    onChange={(e) => setUsername(e.currentTarget.value)}
                    size="lg"
                    autoComplete="username"
                    required
                    autoFocus={!ssoEnabled}
                  />
                  <PasswordInput
                    label={t('비밀번호')}
                    value={password}
                    onChange={(e) => setPassword(e.currentTarget.value)}
                    size="lg"
                    autoComplete="current-password"
                    required
                  />
                  <Button
                    type="submit"
                    size="lg"
                    variant={ssoEnabled ? 'default' : 'filled'}
                    rightSection={<IconArrowRight size={18} />}
                    loading={busy}
                  >
                    {t('로그인')}
                  </Button>
                </Stack>
              </form>
            </Collapse>
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
