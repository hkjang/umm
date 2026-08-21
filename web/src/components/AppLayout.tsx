import { AppShell, Avatar, Burger, Button, Divider, Group, Indicator, Menu, NavLink as MantineNavLink, Paper, ScrollArea, Stack, Text, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconAdjustments, IconArrowLeft, IconBell, IconCalendarCheck, IconCheckupList, IconCloudOff, IconLayoutDashboard, IconLogout, IconMoonStars, IconRefresh, IconSettings, IconSparkles, IconUser } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth-context';
import { api, flushOfflineQueue, offlineQueueCount } from '../api';
import QuickNavigator from './QuickNavigator';

const links = [
  { to: '/today', label: '오늘의 리뷰', icon: IconCalendarCheck },
  { to: '/canvas', label: 'My Space', icon: IconSparkles },
  { to: '/dreams', label: 'Dreams', icon: IconMoonStars },
  { to: '/approvals', label: '검토 · 승인', icon: IconCheckupList },
  { to: '/settings', label: '개인 설정', icon: IconAdjustments },
];

interface AppNotification {
  id: string;
  title: string;
  body: string;
  resourceType?: string;
  resourceId?: string;
  resourceSpaceId?: string;
  readAt?: string;
}

function notificationTarget(item: AppNotification) {
  if (!item.resourceId) return '';
  if (item.resourceType === 'dream') return `/dreams?focus=${encodeURIComponent(item.resourceId)}`;
  if (item.resourceType === 'space') return `/space/${encodeURIComponent(item.resourceId)}`;
  if (item.resourceType === 'note' && item.resourceSpaceId) return `/space/${encodeURIComponent(item.resourceSpaceId)}?note=${encodeURIComponent(item.resourceId)}`;
  return '';
}

export default function AppLayout() {
  const [opened, { toggle, close }] = useDisclosure(false);
  const { user, meta, logout } = useAuth();
  const location = useLocation(); const navigate = useNavigate();
  const isAdmin = location.pathname.startsWith('/admin');
  const isLinkActive = (to: string) => to === '/'
    ? location.pathname === '/'
    : to === '/canvas' ? location.pathname === '/canvas' || location.pathname.startsWith('/space/')
    : location.pathname === to;
  const [notifications,setNotifications]=useState<AppNotification[]>([]);const [unread,setUnread]=useState(0);
  const [online,setOnline]=useState(navigator.onLine);const [queued,setQueued]=useState(offlineQueueCount());const [syncing,setSyncing]=useState(false);
  const loadNotifications=()=>api<{notifications:AppNotification[];unread:number}>('/notifications',{silent:true}).then(v=>{setNotifications(v.notifications);setUnread(v.unread)}).catch(()=>undefined);
  const openNotification=async(item:AppNotification)=>{
    if(!item.readAt)await api(`/notifications/${item.id}/read`,{method:'POST',silent:true}).catch(()=>undefined);
    void loadNotifications();
    const target=notificationTarget(item);
    if(target)navigate(target);
  };
  useEffect(()=>{void loadNotifications();const timer=window.setInterval(loadNotifications,60000);return()=>window.clearInterval(timer)},[]);
  useEffect(()=>{const update=()=>{setOnline(navigator.onLine);setQueued(offlineQueueCount())};const sync=async()=>{update();if(!navigator.onLine)return;setSyncing(true);try{const result=await flushOfflineQueue();setQueued(result.remaining)}finally{setSyncing(false)}};const queuedEvent=()=>setQueued(offlineQueueCount());window.addEventListener('online',sync);window.addEventListener('offline',update);window.addEventListener('umm:offline-queue',queuedEvent);if(navigator.onLine&&offlineQueueCount()>0)void sync();return()=>{window.removeEventListener('online',sync);window.removeEventListener('offline',update);window.removeEventListener('umm:offline-queue',queuedEvent)}},[]);
  return <AppShell className="warm-shell" header={{ height: isAdmin ? 0 : 66 }} navbar={{ width: 238, breakpoint: 'sm', collapsed: { mobile: !opened, desktop: isAdmin } }} padding={0}>
    {!isAdmin && <AppShell.Header className="app-header"><Group h="100%" px={{ base: 'md', sm: 'lg' }} justify="space-between">
      <Group><Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label="메뉴 열기" /><UnstyledButton onClick={() => navigate('/')}><Group gap="sm"><div className="brand-mark">um</div><Text fw={720} fz="lg" visibleFrom="xs">{meta?.serviceName || 'umm'}</Text></Group></UnstyledButton></Group>
      <Group><QuickNavigator/><Menu shadow="md" width={330} position="bottom-end"><Menu.Target><Indicator disabled={unread===0} label={unread>9?'9+':unread} size={17} color="grape"><UnstyledButton aria-label={`알림 ${unread}개`}><IconBell size={22}/></UnstyledButton></Indicator></Menu.Target><Menu.Dropdown><Menu.Label>알림</Menu.Label>{notifications.length===0?<Menu.Item disabled>새 알림이 없습니다.</Menu.Item>:notifications.slice(0,8).map(item=><Menu.Item key={item.id} bg={!item.readAt?'grape.0':undefined} onClick={()=>void openNotification(item)}><Text size="sm" fw={!item.readAt?650:500}>{item.title}</Text><Text size="xs" c="dimmed" lineClamp={2}>{item.body}</Text></Menu.Item>)}</Menu.Dropdown></Menu><Menu shadow="md" width={245} position="bottom-end"><Menu.Target><UnstyledButton aria-label="프로필 메뉴"><Group gap="sm"><Avatar color="grape" radius="xl">{user?.displayName?.slice(0, 1)}</Avatar><div className="profile-text"><Text size="sm" fw={650}>{user?.displayName}</Text><Text size="xs" c="dimmed">{user?.role === 'admin' ? '서비스 관리자' : user?.role === 'team_lead' ? '팀장' : '사용자'}</Text></div></Group></UnstyledButton></Menu.Target><Menu.Dropdown>
        <Menu.Label>내 계정</Menu.Label><Menu.Item leftSection={<IconUser size={16} />} onClick={() => navigate('/settings')}>개인화 및 키 관리</Menu.Item>
        {user?.role === 'admin' && <Menu.Item leftSection={<IconSettings size={16} />} onClick={() => navigate('/admin/overview')}>서비스 관리자</Menu.Item>}
        <Divider my="xs" /><Menu.Label>{meta?.serviceName || 'umm'} · v{meta?.version || 'dev'}</Menu.Label>
        <Menu.Item color="red" leftSection={<IconLogout size={16} />} onClick={async () => { await logout(); navigate('/'); }}>로그아웃</Menu.Item>
      </Menu.Dropdown></Menu></Group>
    </Group></AppShell.Header>}
    <AppShell.Navbar className="app-navbar" p="md" aria-label="주 메뉴"><AppShell.Section grow component={ScrollArea} className="nav-scroll"><Stack gap={5}>
      <Text size="xs" tt="uppercase" fw={700} c="dimmed" px="sm" pt="xs" pb={4}>Thought Space</Text>
      {links.map(({ to, label, icon: Icon }) => <MantineNavLink key={to} component={NavLink} to={to} label={label} leftSection={<Icon size={19} />} active={isLinkActive(to)} aria-current={isLinkActive(to) ? 'page' : undefined} onClick={close} />)}
      {user?.role === 'admin' && <><Divider my="sm" /><Text size="xs" tt="uppercase" fw={700} c="dimmed" px="sm">Service</Text><MantineNavLink component={NavLink} to="/admin/overview" label="서비스 관리자" leftSection={<IconLayoutDashboard size={19} />} onClick={close} /></>}
    </Stack></AppShell.Section><AppShell.Section><Text size="xs" c="dimmed" px="sm">정리는 나중에.<br />생각부터 붙입니다.</Text></AppShell.Section></AppShell.Navbar>
    <AppShell.Main h="100%"><Outlet /></AppShell.Main>
    {(!online||queued>0)&&<Paper className="network-status" role="status" aria-live="polite" shadow="md" radius="xl" px="md" py="xs"><Group gap="xs" wrap="nowrap">{online?<IconRefresh className={syncing?'spin':''} size={17}/>:<IconCloudOff size={17}/>}<Text size="sm" fw={650}>{online?(syncing?'오프라인 변경 동기화 중':`${queued}개 변경이 연결을 기다리는 중`):`오프라인 · ${queued}개 변경을 안전하게 보관 중`}</Text>{online&&queued>0&&!syncing&&<Button size="compact-xs" variant="subtle" onClick={async()=>{setSyncing(true);try{const result=await flushOfflineQueue();setQueued(result.remaining)}finally{setSyncing(false)}}}>지금 동기화</Button>}</Group></Paper>}
    {!isAdmin && <nav className="mobile-tabs" aria-label="모바일 주 메뉴">{links.slice(0,3).map(({to,label,icon:Icon}) => <Button key={to} component={NavLink} to={to} variant="subtle" color={isLinkActive(to)?'grape':'gray'} aria-current={isLinkActive(to) ? 'page' : undefined} px="xs" leftSection={<Icon size={19} />}>{label.split(' ')[0]}</Button>)}</nav>}
    {isAdmin && <Button className="admin-back-button" pos="fixed" top={16} left={16} style={{zIndex:80}} variant="white" color="dark" leftSection={<IconArrowLeft size={18}/>} onClick={() => navigate('/')}>내 공간</Button>}
    {isAdmin && <QuickNavigator admin/>}
  </AppShell>;
}
