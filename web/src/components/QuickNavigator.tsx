import {
  Badge,
  Button,
  Group,
  Kbd,
  Loader,
  Modal,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  UnstyledButton,
} from '@mantine/core';
import {
  IconAdjustments,
  IconCalendarCheck,
  IconCheckupList,
  IconFileText,
  IconHome,
  IconKeyboard,
  IconLayoutDashboard,
  IconMoonStars,
  IconSearch,
  IconSparkles,
} from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, type NoteSearchResult, type Space } from '../api';
import { useAuth } from '../auth-context';
import { useTranslation } from '../i18n';
import { showError } from '../ui-notifications';

interface QuickItem {
  id: string;
  label: string;
  description: string;
  to?: string;
  icon: typeof IconHome;
  badge?: string;
  action?: () => void;
}

const normalize = (value: string, tag = 'ko-KR') => value.normalize('NFKC').toLocaleLowerCase(tag).trim();

export default function QuickNavigator({ admin = false }: { admin?: boolean }) {
  const { user } = useAuth();
  const { t, locale } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [opened, setOpened] = useState(false);
  const [helpOpened, setHelpOpened] = useState(false);
  const [query, setQuery] = useState('');
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [notes, setNotes] = useState<NoteSearchResult[]>([]);
  const [searchingNotes, setSearchingNotes] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const mod = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl';

  useEffect(() => {
    if (opened)
      void api<{ spaces: Space[] }>('/spaces')
        .then((value) => setSpaces(value.spaces))
        .catch(() => setSpaces([]));
  }, [opened]);

  useEffect(() => {
    if (!opened) return;
    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [opened]);

  useEffect(() => {
    const term = normalize(query);
    if (!opened || term.length === 0) {
      setNotes([]);
      setSearchingNotes(false);
      return;
    }
    let active = true;
    setSearchingNotes(true);
    const timer = window.setTimeout(() => {
      void api<{ notes: NoteSearchResult[] }>(`/search?q=${encodeURIComponent(term)}&limit=12`, { silent: true })
        .then((value) => {
          if (active) setNotes(value.notes);
        })
        .catch(() => {
          if (active) {
            setNotes([]);
            showError(
              t('메모 검색 결과를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.'),
              t('빠른 이동'),
              'quick-note-search',
            );
          }
        })
        .finally(() => {
          if (active) setSearchingNotes(false);
        });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [opened, query]);

  const destinations = useMemo<QuickItem[]>(() => {
    const next: QuickItem[] = [
      {
        id: 'today',
        label: t('오늘의 리뷰'),
        description: t('다시 볼 생각과 새 활동'),
        to: '/today',
        icon: IconCalendarCheck,
      },
      { id: 'home', label: t('내 생각 공간'), description: t('캔버스로 이동'), to: '/canvas', icon: IconHome },
      { id: 'dreams', label: 'Dreams', description: t('새롭게 발견된 생각'), to: '/dreams', icon: IconMoonStars },
      {
        id: 'approvals',
        label: t('검토 · 승인'),
        description: t('요청과 승인 상태'),
        to: '/approvals',
        icon: IconCheckupList,
      },
      {
        id: 'settings',
        label: t('개인 설정'),
        description: t('개인화와 API 키'),
        to: '/settings',
        icon: IconAdjustments,
      },
    ];
    if (user?.role === 'admin')
      next.push({
        id: 'admin',
        label: t('서비스 관리자'),
        description: t('운영 및 서비스 설정'),
        to: '/admin/overview',
        icon: IconLayoutDashboard,
      });
    return next;
  }, [t, user?.role]);

  const items = useMemo(() => {
    const all: QuickItem[] = [
      ...destinations,
      ...spaces.map((space) => ({
        id: `space:${space.id}`,
        label: space.name,
        description: t('생각 공간'),
        to: `/space/${space.id}`,
        icon: IconSparkles,
      })),
      {
        id: 'shortcuts',
        label: t('키보드 단축키'),
        description: t('전체 단축키 안내'),
        icon: IconKeyboard,
        action: () => setHelpOpened(true),
      },
    ];
    const collationTag = locale === 'ko' ? 'ko-KR' : 'en-US';
    const terms = normalize(query, collationTag).split(/\s+/).filter(Boolean);
    if (terms.length === 0) return all;
    const localMatches = all.filter((item) =>
      terms.every((term) => normalize(`${item.label} ${item.description}`, collationTag).includes(term)),
    );
    const noteMatches: QuickItem[] = notes.map((note) => {
      const content = note.content.replace(/\s+/g, ' ').trim();
      const title = note.title.trim() || content.slice(0, 52) || t('내용 없는 메모');
      return {
        id: `note:${note.id}`,
        label: title,
        description: `${note.spaceName} · ${note.reason || content.slice(0, 90)}`,
        to: `/space/${note.spaceId}?note=${note.id}`,
        icon: IconFileText,
        badge: `${Math.round((note.score || 0) * 100)}%`,
      };
    });
    return [...localMatches, ...noteMatches];
  }, [destinations, locale, notes, query, spaces, t]);

  useEffect(() => setActiveIndex(0), [query, opened]);

  const select = (item?: QuickItem) => {
    if (!item) return;
    setOpened(false);
    setQuery('');
    setNotes([]);
    if (item.to) navigate(item.to);
    item.action?.();
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing =
        !!target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable);
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault();
        setOpened((value) => !value);
        return;
      }
      if (!editing && event.key === '?') {
        event.preventDefault();
        setHelpOpened(true);
        return;
      }
      if (!editing && event.altKey && !event.metaKey && !event.ctrlKey) {
        const destination = destinations[Number(event.key) - 1];
        if (destination?.to) {
          event.preventDefault();
          navigate(destination.to);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [destinations, navigate]);

  const shortcuts = [
    [`${mod} + K`, t('빠른 이동 열기')],
    ['Alt + 1…5', t('주요 화면으로 이동')],
    ['?', t('단축키 안내 열기')],
    ['N', t('새 생각 입력')],
    [t('/  또는  {mod} + F', { mod }), t('현재 공간 검색')],
    ['Delete / Backspace', t('선택한 메모 삭제')],
    [`${mod} + A`, t('현재 공간 메모 전체 선택')],
    [`${mod} + Z`, t('위치 이동 취소')],
    [`${mod} + Shift + Z`, t('위치 이동 다시 실행')],
    ['F', t('모든 생각 화면에 맞추기')],
    ['Tab', t('생각 사이 이동')],
    ['Enter', t('선택한 생각 편집 시작')],
    [t('방향키'), t('선택한 생각 위치 옮기기')],
    ['Esc', t('검색 및 선택 해제')],
  ];

  return (
    <>
      <Button
        className={admin ? 'quick-nav-trigger quick-nav-trigger-admin' : 'quick-nav-trigger'}
        aria-label={t('빠른 이동')}
        variant={admin ? 'white' : 'subtle'}
        color="dark"
        size="compact-sm"
        leftSection={<IconSearch size={16} />}
        onClick={() => setOpened(true)}
      >
        {t('빠른 이동')}{' '}
        <Kbd ml="xs" size="xs">
          {mod} K
        </Kbd>
      </Button>
      <Modal
        opened={opened}
        onClose={() => {
          setOpened(false);
          setQuery('');
          setNotes([]);
        }}
        title={t('빠른 이동')}
        centered
        size="lg"
        classNames={{ content: 'quick-nav-modal' }}
      >
        <TextInput
          ref={searchInputRef}
          data-autofocus
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          leftSection={<IconSearch size={18} />}
          rightSection={searchingNotes ? <Loader size={17} /> : undefined}
          placeholder={t('화면, 공간 또는 메모 검색')}
          size="lg"
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' && items.length > 0) {
              event.preventDefault();
              setActiveIndex((value) => Math.min(items.length - 1, value + 1));
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActiveIndex((value) => Math.max(0, value - 1));
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              select(items[activeIndex]);
            }
          }}
        />
        <ScrollArea.Autosize mah={430} mt="md" type="auto">
          <Stack gap={5} role="listbox" aria-label={t('빠른 이동 결과')}>
            {items.map((item, index) => (
              <UnstyledButton
                key={item.id}
                className="quick-nav-item"
                data-active={index === activeIndex || undefined}
                aria-selected={index === activeIndex}
                role="option"
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => select(item)}
              >
                <Group wrap="nowrap">
                  <ThemeIcon variant="light" color="grape" size="lg">
                    <item.icon size={19} />
                  </ThemeIcon>
                  <div className="quick-nav-copy">
                    <Text fw={650} lineClamp={1}>
                      {item.label}
                    </Text>
                    <Text size="xs" c="dimmed" lineClamp={1}>
                      {item.description}
                    </Text>
                  </div>
                  {item.badge && (
                    <Badge ml="auto" variant="light" color="blue">
                      {item.badge}
                    </Badge>
                  )}
                  {item.to === location.pathname && (
                    <Badge ml="auto" variant="light" color="grape">
                      {t('현재')}
                    </Badge>
                  )}
                </Group>
              </UnstyledButton>
            ))}
            {items.length === 0 && !searchingNotes && (
              <Text c="dimmed" ta="center" py="xl">
                {t('일치하는 화면, 공간 또는 메모가 없습니다.')}
              </Text>
            )}
          </Stack>
        </ScrollArea.Autosize>
        <Text size="xs" c="dimmed" mt="md">
          {t('↑↓ 선택 · Enter 이동 · Esc 닫기')}
        </Text>
      </Modal>
      <Modal opened={helpOpened} onClose={() => setHelpOpened(false)} title={t('키보드 단축키')} centered size="md">
        <Stack gap="xs">
          {shortcuts.map(([keys, label]) => (
            <Group key={keys} justify="space-between" wrap="nowrap" className="shortcut-row">
              <Text size="sm">{label}</Text>
              <Kbd>{keys}</Kbd>
            </Group>
          ))}
        </Stack>
        <Text size="xs" c="dimmed" mt="lg">
          {t('입력창을 편집하는 동안에는 전역 이동·삭제 단축키가 실행되지 않습니다.')}
        </Text>
      </Modal>
    </>
  );
}
