import { useEffect, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Code,
  CopyButton,
  Divider,
  Group,
  Modal,
  NumberInput,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import {
  IconCheck,
  IconCopy,
  IconKey,
  IconMoonStars,
  IconPlayerPlay,
  IconRefresh,
  IconShieldLock,
  IconTrash,
  IconVectorBezier,
  IconWebhook,
} from '@tabler/icons-react';
import { api, json, type EdgeStyle, type Preferences } from '../api';
import { useAuth } from '../auth-context';
import SessionsCard from '../components/SessionsCard';
import { useTranslation } from '../i18n';
import { writeLocalStorage } from '../lib/browser-storage';

interface APIKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  status: string;
  expiresAt?: string;
  overlapUntil?: string;
  lastUsedAt?: string;
  createdAt: string;
}
interface Webhook {
  id: string;
  name: string;
  url: string;
  events: string[];
  active: boolean;
  failureCount: number;
  lastDeliveredAt?: string;
  lastError: string;
  createdAt: string;
}

function EdgePreview({ style }: { style: EdgeStyle }) {
  const { t } = useTranslation();
  const path =
    style === 'straight'
      ? 'M8 34 L112 34'
      : style === 'smoothstep'
        ? 'M8 34 H44 Q54 34 54 24 V18 Q54 8 64 8 H112'
        : 'M8 34 C38 -2 78 70 112 22';
  return (
    <svg className="edge-preview" viewBox="0 0 120 44" role="img" aria-label={t('선택한 연결선 미리보기')}>
      <circle cx="7" cy="34" r="4" />
      <path d={path} />
      <circle cx="113" cy={style === 'smoothstep' ? 8 : style === 'bezier' ? 22 : 34} r="4" />
    </svg>
  );
}

/**
 * The word for a key's state, rather than the value it is stored as.
 *
 * The webhook list directly below this one already says 활성 and 중지 in the
 * reader's language. The key list said `active`, `overlap` and `revoked` — the
 * same idea, on the same screen, in the other convention.
 *
 * Written out rather than looked up in a map, because a dynamic key never
 * reaches the translation extractor and would ship untranslated.
 */
function keyStatusLabel(status: string, t: (key: string) => string): string {
  if (status === 'active') return t('사용 중');
  if (status === 'overlap') return t('교체 중');
  if (status === 'revoked') return t('폐기됨');
  return status;
}

export default function PersonalSettingsPage() {
  const { meta } = useAuth();
  const { t, formatDate } = useTranslation();
  const [prefs, setPrefs] = useState<Preferences>();
  const [keys, setKeys] = useState<APIKey[]>([]);
  const [available, setAvailable] = useState<string[]>([]);
  const [overlap, setOverlap] = useState(24);
  const [opened, setOpened] = useState(false);
  const [name, setName] = useState('My integration');
  const [scopes, setScopes] = useState<string[]>(['notes:read']);
  const [days, setDays] = useState<number | string>(90);
  const [secret, setSecret] = useState('');
  const [message, setMessage] = useState('');
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [webhookEvents, setWebhookEvents] = useState<string[]>([]);
  const [hookOpened, setHookOpened] = useState(false);
  const [hookName, setHookName] = useState('Automation');
  const [hookURL, setHookURL] = useState('');
  const [hookSelected, setHookSelected] = useState<string[]>(['note.created']);
  const [hookSecret, setHookSecret] = useState('');
  const load = () =>
    Promise.all([
      api<Preferences>('/preferences').then((value) => {
        setPrefs(value);
        writeLocalStorage('umm:edge-style', value.edge_style || 'bezier');
      }),
      api<{ keys: APIKey[]; availableScopes: string[]; rotationOverlapHours: number }>('/api-keys').then((v) => {
        setKeys(v.keys);
        setAvailable(v.availableScopes);
        setOverlap(v.rotationOverlapHours);
      }),
      api<{ webhooks: Webhook[]; supportedEvents: string[] }>('/webhooks').then((value) => {
        setWebhooks(value.webhooks);
        setWebhookEvents(value.supportedEvents);
      }),
    ]);
  useEffect(() => {
    void load().catch(() => undefined);
  }, []);
  const savePrefs = async (next: Preferences) => {
    const previous = prefs;
    setPrefs(next);
    try {
      const saved = await api<Preferences>('/preferences', json('PUT', next));
      setPrefs(saved);
      writeLocalStorage('umm:edge-style', saved.edge_style);
      setMessage(t('개인 설정을 저장했습니다.'));
    } catch {
      setPrefs(previous);
    }
  };
  const create = async () => {
    try {
      const v = await api<{ key: APIKey; secret: string }>(
        '/api-keys',
        json('POST', { name, scopes, expiresDays: Number(days) }),
      );
      setSecret(v.secret);
      setKeys((all) => [v.key, ...all]);
    } catch {
      /* 화면 알림에서 안내합니다. */
    }
  };
  const rotate = async (id: string) => {
    if (!window.confirm(t('{hours}시간 동안 이전 키와 새 키를 함께 사용할까요?', { hours: overlap }))) return;
    try {
      const v = await api<{ key: APIKey; secret: string }>(`/api-keys/${id}/rotate`, { method: 'POST' });
      setSecret(v.secret);
      await load();
    } catch {
      /* 화면 알림에서 안내합니다. */
    }
  };
  const revoke = async (id: string) => {
    if (!window.confirm(t('이 키를 즉시 폐기할까요? 이 작업은 되돌릴 수 없습니다.'))) return;
    try {
      await api(`/api-keys/${id}`, { method: 'DELETE' });
      await load();
    } catch {
      /* 화면 알림에서 안내합니다. */
    }
  };
  const changeScope = async (key: APIKey, scope: string, checked: boolean) => {
    const next = checked ? [...key.scopes, scope] : key.scopes.filter((v) => v !== scope);
    if (next.length === 0) return;
    try {
      await api(`/api-keys/${key.id}`, json('PUT', { scopes: next }));
      setKeys((all) => all.map((v) => (v.id === key.id ? { ...v, scopes: next } : v)));
    } catch {
      /* 화면 알림에서 안내합니다. */
    }
  };
  const createHook = async () => {
    const value = await api<{ id: string; secret: string }>(
      '/webhooks',
      json('POST', { name: hookName, url: hookURL, events: hookSelected }),
    );
    setHookSecret(value.secret);
    await load();
  };
  const testHook = async (id: string) => {
    await api(`/webhooks/${id}/test`, { method: 'POST' });
    setMessage(t('시험 이벤트를 성공적으로 전송했습니다.'));
    await load();
  };
  const deleteHook = async (id: string) => {
    if (!window.confirm(t('이 웹훅과 전달 기록을 삭제할까요?'))) return;
    await api(`/webhooks/${id}`, { method: 'DELETE' });
    await load();
  };
  const toggleHook = async (hook: Webhook) => {
    await api(
      `/webhooks/${hook.id}`,
      json('PUT', { name: hook.name, url: hook.url, events: hook.events, active: !hook.active }),
    );
    setMessage(t(hook.active ? '웹훅을 중지했습니다.' : '웹훅을 다시 활성화했습니다.'));
    await load();
  };
  const rotateHook = async (id: string) => {
    const value = await api<{ secret: string }>(`/webhooks/${id}/rotate-secret`, { method: 'POST' });
    setHookSecret(value.secret);
    setHookOpened(true);
  };
  return (
    <div className="settings-page">
      <Stack maw={980} mx="auto" gap="xl">
        <div>
          <Text size="sm" c="grape.7" fw={700}>
            PERSONAL
          </Text>
          <Title order={1} mt={5}>
            {t('나에게 맞는 umm')}
          </Title>
          <Text c="dimmed" mt="xs">
            {t('개인 경험과 나의 연동 키를 관리합니다. 서비스 전체 설정과는 분리되어 있습니다.')}
          </Text>
        </div>
        {message && (
          <Alert color="green" icon={<IconCheck size={18} />} withCloseButton onClose={() => setMessage('')}>
            {message}
          </Alert>
        )}
        <Card radius="lg" p="xl" withBorder>
          <Group justify="space-between" align="flex-start">
            <Group align="flex-start">
              <IconMoonStars color="#765c96" />
              <div>
                <Title order={2} fz="xl">
                  Dream
                </Title>
                <Text c="dimmed" mt={4}>
                  {t('밤사이 내 생각에서 새로운 생각을 만들어 주세요.')}
                </Text>
              </div>
            </Group>
            {prefs && (
              <Switch
                size="lg"
                disabled={!meta?.dreamEnabled || !meta.dreamAllowUserDisable}
                checked={meta?.dreamEnabled && prefs.dream_enabled}
                onChange={(e) => void savePrefs({ ...prefs, dream_enabled: e.currentTarget.checked })}
              />
            )}
          </Group>
          {!meta?.dreamEnabled && (
            <Alert color="gray" mt="lg">
              {t('서비스 관리자가 Dream 기능을 아직 활성화하지 않았습니다.')}
            </Alert>
          )}
          {prefs && (
            <SimpleGrid cols={{ base: 1, sm: 2 }} mt="xl">
              <Select
                disabled={!meta?.dreamEnabled}
                label={t('빈도')}
                size="md"
                value={prefs.dream_frequency}
                data={[
                  { value: 'daily', label: t('매일') },
                  { value: 'three_week', label: t('주 3회') },
                  { value: 'weekly', label: t('주 1회') },
                ]}
                onChange={(v) => v && void savePrefs({ ...prefs, dream_frequency: v })}
              />
              <Select
                disabled={!meta?.dreamEnabled}
                label={t('Dream 스타일')}
                size="md"
                value={prefs.dream_style}
                data={[
                  { value: 'auto', label: t('자동 선택') },
                  { value: 'connection', label: t('연결') },
                  { value: 'question', label: t('질문') },
                  { value: 'expansion', label: t('확장') },
                  { value: 'free', label: t('자유') },
                ]}
                onChange={(v) => v && void savePrefs({ ...prefs, dream_style: v })}
              />
              <Switch
                disabled={!meta?.dreamEnabled}
                label={t('오래된 생각도 활용')}
                checked={prefs.include_old_notes}
                onChange={(e) => void savePrefs({ ...prefs, include_old_notes: e.currentTarget.checked })}
              />
              <Switch
                disabled={!meta?.dreamEnabled}
                label={t('Dream 도착 알림')}
                checked={prefs.dream_notifications}
                onChange={(e) => void savePrefs({ ...prefs, dream_notifications: e.currentTarget.checked })}
              />
            </SimpleGrid>
          )}
          {prefs && meta?.dreamEnabled && (
            <Group mt="lg">
              <Text size="sm" c="dimmed">
                {t('Dream 잠시 쉬기')}
              </Text>
              {[
                { label: t('오늘'), d: 1 },
                { label: t('3일'), d: 3 },
                { label: t('일주일'), d: 7 },
              ].map((v) => (
                <Button
                  key={v.d}
                  size="xs"
                  variant="subtle"
                  onClick={() =>
                    void savePrefs({ ...prefs, dream_pause_until: new Date(Date.now() + v.d * 86400000).toISOString() })
                  }
                >
                  {v.label}
                </Button>
              ))}
              {meta.dreamAllowUserDisable && (
                <Button
                  size="xs"
                  variant="subtle"
                  color="gray"
                  onClick={() => void savePrefs({ ...prefs, dream_enabled: false })}
                >
                  {t('끄기')}
                </Button>
              )}
              <Button
                size="xs"
                variant="subtle"
                color="grape"
                onClick={() => void savePrefs({ ...prefs, dream_enabled: true, dream_pause_until: undefined })}
              >
                {t('다시 시작')}
              </Button>
            </Group>
          )}
        </Card>
        <Card radius="lg" p="xl" withBorder>
          <Group justify="space-between" align="flex-start" wrap="nowrap">
            <Group align="flex-start" wrap="nowrap">
              <IconVectorBezier color="#765c96" />
              <div>
                <Title order={2} fz="xl">
                  {t('캔버스 연결선')}
                </Title>
                <Text c="dimmed" mt={4}>
                  {t('생각 사이의 연결을 읽기 편한 형태로 표시합니다.')}
                </Text>
              </div>
            </Group>
            {prefs && <EdgePreview style={prefs.edge_style || 'bezier'} />}
          </Group>
          {prefs && (
            <Select
              mt="xl"
              maw={420}
              label={t('연결선 형태')}
              description={t('새 연결과 기존 연결에 즉시 함께 적용됩니다.')}
              value={prefs.edge_style || 'bezier'}
              data={[
                { value: 'bezier', label: t('부드러운 곡선') },
                { value: 'smoothstep', label: t('둥근 꺾은선') },
                { value: 'straight', label: t('직선') },
              ]}
              onChange={(value) => value && void savePrefs({ ...prefs, edge_style: value as EdgeStyle })}
            />
          )}
          {prefs && (
            <Switch
              mt="xl"
              label={t('리뷰 요약에 활동 포함')}
              description={t('다시 볼 생각과 최근 협업 활동을 오늘의 리뷰에 포함합니다.')}
              checked={prefs.review_digest}
              onChange={(event) => void savePrefs({ ...prefs, review_digest: event.currentTarget.checked })}
            />
          )}
        </Card>
        <Card radius="lg" p="xl" withBorder>
          <Group justify="space-between">
            <Group>
              <IconShieldLock />
              <div>
                <Title order={2} fz="xl">
                  {t('개인 API · MCP 키')}
                </Title>
                <Text c="dimmed" mt={4}>
                  {t('권한을 최소로 부여하고 정기적으로 회전하세요.')}
                </Text>
              </div>
            </Group>
            <Button
              leftSection={<IconKey size={17} />}
              onClick={() => {
                setSecret('');
                setOpened(true);
              }}
            >
              {t('새 키')}
            </Button>
          </Group>
          <Divider my="lg" />
          {keys.length === 0 ? (
            <Text c="dimmed">{t('아직 만든 키가 없습니다.')}</Text>
          ) : (
            <Stack>
              {keys.map((key) => (
                <Card key={key.id} bg="gray.0" radius="md">
                  <Group justify="space-between" align="flex-start">
                    <div>
                      <Group>
                        <Text fw={650}>{key.name}</Text>
                        <Badge
                          color={key.status === 'active' ? 'green' : key.status === 'overlap' ? 'yellow' : 'gray'}
                          variant="light"
                        >
                          {keyStatusLabel(key.status, t)}
                        </Badge>
                      </Group>
                      {/*
                        The date a key stops working, not the date it was made.
                        
                        This line used to read `umm_key_… · 2026. 8. 26.` — the
                        creation date, unlabelled, while the response carried an
                        expiry three months out that appeared nowhere. A key you
                        forgot about is exactly the one whose expiry you need,
                        and the page was showing the one date you can least act
                        on.
                        
                        During a rotation it matters more still: the old key
                        keeps working for a day and then stops. The badge said
                        `overlap` and nothing said until when, so the deadline
                        the whole rotation is about was the one thing missing.
                      */}
                      <Text size="sm" c="dimmed" mt={4}>
                        umm_key_{key.prefix}_••••
                        {key.status === 'overlap' && key.overlapUntil
                          ? ` · ${t('{date}까지만 동작합니다', {
                              date: formatDate(key.overlapUntil, { dateStyle: 'medium', timeStyle: 'short' }),
                            })}`
                          : key.status === 'revoked'
                            ? ''
                            : key.expiresAt
                              ? ` · ${t('만료 {date}', { date: formatDate(key.expiresAt, { dateStyle: 'medium' }) })}`
                              : ''}
                        {' · '}
                        {key.lastUsedAt
                          ? t('마지막 사용 {date}', { date: formatDate(key.lastUsedAt, { dateStyle: 'medium' }) })
                          : t('아직 사용된 적 없음')}
                      </Text>
                    </div>
                    <Group gap="xs">
                      <Button
                        size="xs"
                        variant="light"
                        leftSection={<IconRefresh size={15} />}
                        disabled={key.status !== 'active'}
                        onClick={() => void rotate(key.id)}
                      >
                        {t('회전')}
                      </Button>
                      <Button
                        size="xs"
                        variant="subtle"
                        color="red"
                        leftSection={<IconTrash size={15} />}
                        disabled={key.status === 'revoked'}
                        onClick={() => void revoke(key.id)}
                      >
                        {t('폐기')}
                      </Button>
                    </Group>
                  </Group>
                  <Group gap="md" mt="md">
                    {available.map((scope) => (
                      <Checkbox
                        key={scope}
                        size="sm"
                        checked={key.scopes.includes(scope)}
                        label={scope}
                        disabled={key.status !== 'active'}
                        onChange={(e) => void changeScope(key, scope, e.currentTarget.checked)}
                      />
                    ))}
                  </Group>
                </Card>
              ))}
            </Stack>
          )}
          <Alert mt="lg" color="blue" variant="light">
            {t('MCP 엔드포인트는')} <Code>/mcp</Code>
            {t('이며, Bearer 키로 인증합니다. 현재 프로토콜은 2026-07-28과 이전 initialize 흐름을 함께 지원합니다.')}
          </Alert>
        </Card>
        <Card radius="lg" p="xl" withBorder>
          <Group justify="space-between">
            <Group>
              <IconWebhook />
              <div>
                <Title order={2} fz="xl">
                  {t('서명 웹훅')}
                </Title>
                <Text c="dimmed" mt={4}>
                  {t('생각과 협업 이벤트를 HTTPS 자동화로 안전하게 전달합니다.')}
                </Text>
              </div>
            </Group>
            <Button
              leftSection={<IconWebhook size={17} />}
              onClick={() => {
                setHookSecret('');
                setHookOpened(true);
              }}
            >
              {t('새 웹훅')}
            </Button>
          </Group>
          <Divider my="lg" />
          {webhooks.length === 0 ? (
            <Text c="dimmed">{t('등록한 웹훅이 없습니다.')}</Text>
          ) : (
            <Stack>
              {webhooks.map((hook) => (
                <Paper key={hook.id} p="md" radius="md" withBorder>
                  <Group justify="space-between" align="flex-start">
                    <div>
                      <Group gap="xs">
                        <Text fw={650}>{hook.name}</Text>
                        <Badge color={hook.active ? 'green' : 'gray'} variant="light">
                          {t(hook.active ? '활성' : '중지')}
                        </Badge>
                        {hook.failureCount > 0 && (
                          <Badge color="red" variant="light">
                            {t('실패 {count}', { count: hook.failureCount })}
                          </Badge>
                        )}
                      </Group>
                      <Text size="xs" c="dimmed" mt={4} style={{ wordBreak: 'break-all' }}>
                        {hook.url}
                      </Text>
                      <Text size="xs" mt="xs">
                        {hook.events.join(' · ')}
                      </Text>
                      {hook.lastError && (
                        <Text size="xs" c="red" mt="xs">
                          {hook.lastError}
                        </Text>
                      )}
                    </div>
                    <Group gap="xs">
                      <Button
                        size="xs"
                        variant="light"
                        leftSection={<IconPlayerPlay size={14} />}
                        disabled={!hook.active}
                        onClick={() => void testHook(hook.id)}
                      >
                        {t('시험')}
                      </Button>
                      <Button size="xs" variant="subtle" onClick={() => void toggleHook(hook)}>
                        {t(hook.active ? '중지' : '재활성화')}
                      </Button>
                      <Button size="xs" variant="subtle" onClick={() => void rotateHook(hook.id)}>
                        {t('키 회전')}
                      </Button>
                      <ActionIcon
                        color="red"
                        variant="subtle"
                        aria-label={t('{name} 삭제', { name: hook.name })}
                        onClick={() => void deleteHook(hook.id)}
                      >
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Group>
                  </Group>
                </Paper>
              ))}
            </Stack>
          )}
          <Alert mt="lg" color="yellow" variant="light">
            {t('내부·사설 주소로의 요청은 SSRF 보호를 위해 차단합니다. 수신 측은')} <Code>X-Umm-Signature-256</Code>{' '}
            {t('HMAC-SHA256 서명을 검증하세요.')}
          </Alert>
        </Card>
        <SessionsCard />
      </Stack>
      <Modal opened={opened} onClose={() => setOpened(false)} title={t('새 개인 키')} centered size="lg">
        <Stack>
          <TextInput label={t('키 이름')} value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <NumberInput label={t('만료 기간(일)')} min={1} max={3650} value={days} onChange={setDays} />
          <Checkbox.Group label={t('권한')} value={scopes} onChange={setScopes}>
            <Stack gap="xs" mt="sm">
              {available.map((v) => (
                <Checkbox key={v} value={v} label={v} />
              ))}
            </Stack>
          </Checkbox.Group>
          {secret ? (
            <Alert color="yellow" title={t('지금 복사하세요. 다시 표시되지 않습니다.')}>
              <Code style={{ wordBreak: 'break-all' }}>{secret}</Code>
              <CopyButton value={secret}>
                {({ copied, copy }) => (
                  <Button
                    mt="md"
                    size="xs"
                    color={copied ? 'green' : 'dark'}
                    leftSection={copied ? <IconCheck size={15} /> : <IconCopy size={15} />}
                    onClick={copy}
                  >
                    {t(copied ? '복사됨' : '키 복사')}
                  </Button>
                )}
              </CopyButton>
            </Alert>
          ) : (
            <Button onClick={() => void create()} disabled={!name.trim() || scopes.length === 0}>
              {t('키 만들기')}
            </Button>
          )}
        </Stack>
      </Modal>
      <Modal opened={hookOpened} onClose={() => setHookOpened(false)} title={t('서명 웹훅')} centered size="lg">
        <Stack>
          {hookSecret ? (
            <Alert color="yellow" title={t('서명 키를 지금 복사하세요.')}>
              <Code style={{ wordBreak: 'break-all' }}>{hookSecret}</Code>
              <CopyButton value={hookSecret}>
                {({ copied, copy }) => (
                  <Button mt="md" size="xs" leftSection={<IconCopy size={15} />} onClick={copy}>
                    {t(copied ? '복사됨' : '키 복사')}
                  </Button>
                )}
              </CopyButton>
            </Alert>
          ) : (
            <>
              <TextInput
                label={t('이름')}
                value={hookName}
                onChange={(event) => setHookName(event.currentTarget.value)}
              />
              <TextInput
                label="HTTPS URL"
                placeholder="https://automation.example.com/umm"
                value={hookURL}
                onChange={(event) => setHookURL(event.currentTarget.value)}
              />
              <Checkbox.Group label={t('전달 이벤트')} value={hookSelected} onChange={setHookSelected}>
                <SimpleGrid cols={{ base: 1, sm: 2 }} mt="sm">
                  {webhookEvents.map((event) => (
                    <Checkbox key={event} value={event} label={event} />
                  ))}
                </SimpleGrid>
              </Checkbox.Group>
              <Button
                disabled={!hookName.trim() || !hookURL.trim() || hookSelected.length === 0}
                onClick={() => void createHook()}
              >
                {t('웹훅 만들기')}
              </Button>
            </>
          )}
        </Stack>
      </Modal>
    </div>
  );
}
