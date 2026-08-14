import { Badge, Button, Group, Kbd, Modal, ScrollArea, Stack, Text, TextInput, ThemeIcon, UnstyledButton } from '@mantine/core';
import { IconAdjustments, IconCheckupList, IconHome, IconKeyboard, IconLayoutDashboard, IconMoonStars, IconSearch, IconSparkles } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, type Space } from '../api';
import { useAuth } from '../auth-context';

interface QuickItem {
  id: string;
  label: string;
  description: string;
  to?: string;
  icon: typeof IconHome;
  action?: () => void;
}

const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase('ko-KR').trim();

export default function QuickNavigator({ admin = false }: { admin?: boolean }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [opened, setOpened] = useState(false);
  const [helpOpened, setHelpOpened] = useState(false);
  const [query, setQuery] = useState('');
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const mod = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl';

  useEffect(() => {
    if (opened) void api<{ spaces: Space[] }>('/spaces').then((value) => setSpaces(value.spaces)).catch(() => setSpaces([]));
  }, [opened]);

  const destinations = useMemo<QuickItem[]>(() => {
    const next: QuickItem[] = [
      { id: 'home', label: '내 생각 공간', description: '캔버스로 이동', to: '/', icon: IconHome },
      { id: 'dreams', label: 'Dreams', description: '새롭게 발견된 생각', to: '/dreams', icon: IconMoonStars },
      { id: 'approvals', label: '검토 · 승인', description: '요청과 승인 상태', to: '/approvals', icon: IconCheckupList },
      { id: 'settings', label: '개인 설정', description: '개인화와 API 키', to: '/settings', icon: IconAdjustments },
    ];
    if (user?.role === 'admin') next.push({ id: 'admin', label: '서비스 관리자', description: '운영 및 서비스 설정', to: '/admin', icon: IconLayoutDashboard });
    return next;
  }, [user?.role]);

  const items = useMemo(() => {
    const all: QuickItem[] = [
      ...destinations,
      ...spaces.map((space) => ({ id: `space:${space.id}`, label: space.name, description: '생각 공간', to: `/space/${space.id}`, icon: IconSparkles })),
      { id: 'shortcuts', label: '키보드 단축키', description: '전체 단축키 안내', icon: IconKeyboard, action: () => setHelpOpened(true) },
    ];
    const terms = normalize(query).split(/\s+/).filter(Boolean);
    return terms.length === 0 ? all : all.filter((item) => terms.every((term) => normalize(`${item.label} ${item.description}`).includes(term)));
  }, [destinations, query, spaces]);

  useEffect(() => setActiveIndex(0), [query, opened]);

  const select = (item?: QuickItem) => {
    if (!item) return;
    setOpened(false);
    if (item.to) navigate(item.to);
    item.action?.();
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = !!target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable);
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault(); setOpened((value) => !value); return;
      }
      if (!editing && event.key === '?') {
        event.preventDefault(); setHelpOpened(true); return;
      }
      if (!editing && event.altKey && !event.metaKey && !event.ctrlKey) {
        const destination = destinations[Number(event.key) - 1];
        if (destination?.to) { event.preventDefault(); navigate(destination.to); }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [destinations, navigate]);

  const shortcuts = [
    [`${mod} + K`, '빠른 이동 열기'], ['Alt + 1…5', '주요 화면으로 이동'], ['?', '단축키 안내 열기'],
    ['N', '새 생각 입력'], [`/  또는  ${mod} + F`, '현재 공간 검색'], ['Delete / Backspace', '선택한 메모 삭제'],
    [`${mod} + A`, '현재 공간 메모 전체 선택'], [`${mod} + Z`, '위치 이동 취소'], [`${mod} + Shift + Z`, '위치 이동 다시 실행'],
    ['F', '모든 생각 화면에 맞추기'], ['Esc', '검색 및 선택 해제'],
  ];

  return <>
    <Button className={admin ? 'quick-nav-trigger quick-nav-trigger-admin' : 'quick-nav-trigger'} aria-label="빠른 이동" variant={admin ? 'white' : 'subtle'} color="dark" size="compact-sm" leftSection={<IconSearch size={16}/>} onClick={() => setOpened(true)}>
      빠른 이동 <Kbd ml="xs" size="xs">{mod} K</Kbd>
    </Button>
    <Modal opened={opened} onClose={() => setOpened(false)} title="빠른 이동" centered size="lg" classNames={{ content: 'quick-nav-modal' }}>
      <TextInput autoFocus value={query} onChange={(event) => setQuery(event.currentTarget.value)} leftSection={<IconSearch size={18}/>} placeholder="화면이나 공간 이름 검색" size="lg" onKeyDown={(event) => {
        if (event.key === 'ArrowDown' && items.length > 0) { event.preventDefault(); setActiveIndex((value) => Math.min(items.length - 1, value + 1)); }
        if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex((value) => Math.max(0, value - 1)); }
        if (event.key === 'Enter') { event.preventDefault(); select(items[activeIndex]); }
      }}/>
      <ScrollArea.Autosize mah={430} mt="md" type="auto">
        <Stack gap={5} role="listbox" aria-label="빠른 이동 결과">
          {items.map((item, index) => <UnstyledButton key={item.id} className="quick-nav-item" data-active={index === activeIndex || undefined} aria-selected={index === activeIndex} role="option" onMouseEnter={() => setActiveIndex(index)} onClick={() => select(item)}>
            <Group wrap="nowrap"><ThemeIcon variant="light" color="grape" size="lg"><item.icon size={19}/></ThemeIcon><div><Text fw={650}>{item.label}</Text><Text size="xs" c="dimmed">{item.description}</Text></div>{item.to === location.pathname && <Badge ml="auto" variant="light" color="grape">현재</Badge>}</Group>
          </UnstyledButton>)}
          {items.length === 0 && <Text c="dimmed" ta="center" py="xl">일치하는 화면이나 공간이 없습니다.</Text>}
        </Stack>
      </ScrollArea.Autosize>
      <Text size="xs" c="dimmed" mt="md">↑↓ 선택 · Enter 이동 · Esc 닫기</Text>
    </Modal>
    <Modal opened={helpOpened} onClose={() => setHelpOpened(false)} title="키보드 단축키" centered size="md">
      <Stack gap="xs">{shortcuts.map(([keys, label]) => <Group key={keys} justify="space-between" wrap="nowrap" className="shortcut-row"><Text size="sm">{label}</Text><Kbd>{keys}</Kbd></Group>)}</Stack>
      <Text size="xs" c="dimmed" mt="lg">입력창을 편집하는 동안에는 전역 이동·삭제 단축키가 실행되지 않습니다.</Text>
    </Modal>
  </>;
}
