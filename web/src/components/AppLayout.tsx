import {
  AppShell,
  Avatar,
  Burger,
  Button,
  Divider,
  Group,
  Menu,
  NavLink as MantineNavLink,
  ScrollArea,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconAdjustments,
  IconArrowLeft,
  IconCalendarCheck,
  IconCheckupList,
  IconLayoutDashboard,
  IconLogout,
  IconMoonStars,
  IconRoute,
  IconSettings,
  IconSparkles,
  IconUser,
} from '@tabler/icons-react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth-context';
import { msg, useTranslation } from '../i18n';
import AppearanceMenu from './AppearanceMenu';
import NotificationMenu from './NotificationMenu';
import OfflineStatus from './OfflineStatus';
import CaptureBox from './CaptureBox';
import QuickNavigator from './QuickNavigator';

const links = [
  { to: '/today', label: msg('오늘의 리뷰'), icon: IconCalendarCheck },
  { to: '/canvas', label: 'My Space', icon: IconSparkles },
  { to: '/dreams', label: 'Dreams', icon: IconMoonStars },
  { to: '/decisions', label: msg('결정 기록'), icon: IconRoute },
  { to: '/approvals', label: msg('검토 · 승인'), icon: IconCheckupList },
  { to: '/settings', label: msg('개인 설정'), icon: IconAdjustments },
];

const roleLabel = (role?: string) =>
  role === 'admin' ? msg('서비스 관리자') : role === 'team_lead' ? msg('팀장') : msg('사용자');

export default function AppLayout() {
  const [opened, { toggle, close }] = useDisclosure(false);
  const { user, meta, logout } = useAuth();
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const isAdmin = location.pathname.startsWith('/admin');
  const isLinkActive = (to: string) =>
    to === '/'
      ? location.pathname === '/'
      : to === '/canvas'
        ? location.pathname === '/canvas' || location.pathname.startsWith('/space/')
        : location.pathname === to;

  return (
    <AppShell
      className="warm-shell"
      header={{ height: isAdmin ? 0 : 66 }}
      navbar={{ width: 238, breakpoint: 'sm', collapsed: { mobile: !opened, desktop: isAdmin } }}
      padding={0}
    >
      {!isAdmin && (
        <AppShell.Header className="app-header">
          <Group h="100%" px={{ base: 'md', sm: 'lg' }} justify="space-between">
            <Group>
              <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label={t('메뉴 열기')} />
              <UnstyledButton onClick={() => navigate('/')}>
                <Group gap="sm">
                  <div className="brand-mark">um</div>
                  <Text fw={720} fz="lg" visibleFrom="xs">
                    {meta?.serviceName || 'umm'}
                  </Text>
                </Group>
              </UnstyledButton>
            </Group>
            <Group>
              <CaptureBox />
              <QuickNavigator />
              <NotificationMenu />
              <Menu shadow="md" width={245} position="bottom-end">
                <Menu.Target>
                  <UnstyledButton aria-label={t('프로필 메뉴')}>
                    <Group gap="sm">
                      <Avatar color="grape" radius="xl">
                        {user?.displayName?.slice(0, 1)}
                      </Avatar>
                      <div className="profile-text">
                        <Text size="sm" fw={650}>
                          {user?.displayName}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {t(roleLabel(user?.role))}
                        </Text>
                      </div>
                    </Group>
                  </UnstyledButton>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Label>{t('내 계정')}</Menu.Label>
                  <Menu.Item leftSection={<IconUser size={16} />} onClick={() => navigate('/settings')}>
                    {t('개인화 및 키 관리')}
                  </Menu.Item>
                  {user?.role === 'admin' && (
                    <Menu.Item leftSection={<IconSettings size={16} />} onClick={() => navigate('/admin/overview')}>
                      {t('서비스 관리자')}
                    </Menu.Item>
                  )}
                  <Divider my="xs" />
                  <AppearanceMenu />
                  <Divider my="xs" />
                  <Menu.Label>
                    {meta?.serviceName || 'umm'} · v{meta?.version || 'dev'}
                  </Menu.Label>
                  <Menu.Item
                    color="red"
                    leftSection={<IconLogout size={16} />}
                    onClick={async () => {
                      await logout();
                      navigate('/');
                    }}
                  >
                    {t('로그아웃')}
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            </Group>
          </Group>
        </AppShell.Header>
      )}
      <AppShell.Navbar className="app-navbar" p="md" aria-label={t('주 메뉴')}>
        <AppShell.Section grow component={ScrollArea} className="nav-scroll">
          <Stack gap={5}>
            <Text size="xs" tt="uppercase" fw={700} c="dimmed" px="sm" pt="xs" pb={4}>
              Thought Space
            </Text>
            {links.map(({ to, label, icon: Icon }) => (
              <MantineNavLink
                key={to}
                component={NavLink}
                to={to}
                label={t(label)}
                leftSection={<Icon size={19} />}
                active={isLinkActive(to)}
                aria-current={isLinkActive(to) ? 'page' : undefined}
                onClick={close}
              />
            ))}
            {user?.role === 'admin' && (
              <>
                <Divider my="sm" />
                <Text size="xs" tt="uppercase" fw={700} c="dimmed" px="sm">
                  Service
                </Text>
                <MantineNavLink
                  component={NavLink}
                  to="/admin/overview"
                  label={t('서비스 관리자')}
                  leftSection={<IconLayoutDashboard size={19} />}
                  onClick={close}
                />
              </>
            )}
          </Stack>
        </AppShell.Section>
        <AppShell.Section>
          <Text size="xs" c="dimmed" px="sm">
            {t('정리는 나중에.')}
            <br />
            {t('생각부터 붙입니다.')}
          </Text>
        </AppShell.Section>
      </AppShell.Navbar>
      {/* No h="100%" here: an inline height outranks the stylesheet, and it let
          the region grow to its content instead of bounding it, which is what
          left long pages unscrollable. .app-main owns the height. */}
      <AppShell.Main className="app-main">
        <Outlet />
      </AppShell.Main>
      <OfflineStatus />
      {!isAdmin && (
        <nav className="mobile-tabs" aria-label={t('모바일 주 메뉴')}>
          {links.slice(0, 3).map(({ to, label, icon: Icon }) => (
            <Button
              key={to}
              component={NavLink}
              to={to}
              variant="subtle"
              color={isLinkActive(to) ? 'grape' : 'gray'}
              aria-current={isLinkActive(to) ? 'page' : undefined}
              px="xs"
              leftSection={<Icon size={19} />}
            >
              {t(label).split(' ')[0]}
            </Button>
          ))}
        </nav>
      )}
      {isAdmin && (
        <Button
          className="admin-back-button"
          pos="fixed"
          top={16}
          left={16}
          style={{ zIndex: 80 }}
          variant="white"
          color="dark"
          leftSection={<IconArrowLeft size={18} />}
          onClick={() => navigate('/')}
        >
          {t('내 공간')}
        </Button>
      )}
      {isAdmin && <QuickNavigator admin />}
    </AppShell>
  );
}
