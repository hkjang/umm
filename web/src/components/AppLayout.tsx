import { AppShell, Avatar, Burger, Button, Divider, Group, Menu, NavLink as MantineNavLink, ScrollArea, Stack, Text, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconAdjustments, IconArrowLeft, IconCheckupList, IconLayoutDashboard, IconLogout, IconMoonStars, IconSettings, IconSparkles, IconUser } from '@tabler/icons-react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth-context';

const links = [
  { to: '/', label: 'My Space', icon: IconSparkles },
  { to: '/dreams', label: 'Dreams', icon: IconMoonStars },
  { to: '/approvals', label: '검토 · 승인', icon: IconCheckupList },
  { to: '/settings', label: '개인 설정', icon: IconAdjustments },
];

export default function AppLayout() {
  const [opened, { toggle, close }] = useDisclosure(false);
  const { user, meta, logout } = useAuth();
  const location = useLocation(); const navigate = useNavigate();
  const isAdmin = location.pathname.startsWith('/admin');
  return <AppShell className="warm-shell" header={{ height: isAdmin ? 0 : 66 }} navbar={{ width: 238, breakpoint: 'sm', collapsed: { mobile: !opened, desktop: isAdmin } }} padding={0}>
    {!isAdmin && <AppShell.Header className="app-header"><Group h="100%" px={{ base: 'md', sm: 'lg' }} justify="space-between">
      <Group><Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label="메뉴 열기" /><UnstyledButton onClick={() => navigate('/')}><Group gap="sm"><div className="brand-mark">um</div><Text fw={720} fz="lg" visibleFrom="xs">{meta?.serviceName || 'umm'}</Text></Group></UnstyledButton></Group>
      <Menu shadow="md" width={245} position="bottom-end"><Menu.Target><UnstyledButton aria-label="프로필 메뉴"><Group gap="sm"><Avatar color="grape" radius="xl">{user?.displayName?.slice(0, 1)}</Avatar><div className="profile-text"><Text size="sm" fw={650}>{user?.displayName}</Text><Text size="xs" c="dimmed">{user?.role === 'admin' ? '서비스 관리자' : user?.role === 'team_lead' ? '팀장' : '사용자'}</Text></div></Group></UnstyledButton></Menu.Target><Menu.Dropdown>
        <Menu.Label>내 계정</Menu.Label><Menu.Item leftSection={<IconUser size={16} />} onClick={() => navigate('/settings')}>개인화 및 키 관리</Menu.Item>
        {user?.role === 'admin' && <Menu.Item leftSection={<IconSettings size={16} />} onClick={() => navigate('/admin')}>서비스 관리자</Menu.Item>}
        <Divider my="xs" /><Menu.Label>{meta?.serviceName || 'umm'} · v{meta?.version || 'dev'}</Menu.Label>
        <Menu.Item color="red" leftSection={<IconLogout size={16} />} onClick={async () => { await logout(); navigate('/'); }}>로그아웃</Menu.Item>
      </Menu.Dropdown></Menu>
    </Group></AppShell.Header>}
    <AppShell.Navbar className="app-navbar" p="md"><AppShell.Section grow component={ScrollArea} className="nav-scroll"><Stack gap={5}>
      <Text size="xs" tt="uppercase" fw={700} c="dimmed" px="sm" pt="xs" pb={4}>Thought Space</Text>
      {links.map(({ to, label, icon: Icon }) => <MantineNavLink key={to} component={NavLink} to={to} label={label} leftSection={<Icon size={19} />} active={location.pathname === to} onClick={close} />)}
      {user?.role === 'admin' && <><Divider my="sm" /><Text size="xs" tt="uppercase" fw={700} c="dimmed" px="sm">Service</Text><MantineNavLink component={NavLink} to="/admin" label="서비스 관리자" leftSection={<IconLayoutDashboard size={19} />} onClick={close} /></>}
    </Stack></AppShell.Section><AppShell.Section><Text size="xs" c="dimmed" px="sm">정리는 나중에.<br />생각부터 붙입니다.</Text></AppShell.Section></AppShell.Navbar>
    <AppShell.Main h="100%"><Outlet /></AppShell.Main>
    {!isAdmin && <nav className="mobile-tabs" aria-label="모바일 주 메뉴">{links.slice(0,3).map(({to,label,icon:Icon}) => <Button key={to} component={NavLink} to={to} variant="subtle" color={location.pathname===to?'grape':'gray'} px="xs" leftSection={<Icon size={19} />}>{label.split(' ')[0]}</Button>)}</nav>}
    {isAdmin && <Button pos="fixed" top={16} left={16} style={{zIndex:80}} variant="white" color="dark" leftSection={<IconArrowLeft size={18}/>} onClick={() => navigate('/')}>내 공간</Button>}
  </AppShell>;
}
