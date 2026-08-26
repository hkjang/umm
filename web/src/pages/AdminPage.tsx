import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Code,
  Divider,
  Group,
  Modal,
  NumberInput,
  Paper,
  PasswordInput,
  Progress,
  ScrollArea,
  Select,
  SimpleGrid,
  Slider,
  Stack,
  Switch,
  Table,
  TagsInput,
  Text,
  Textarea,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  IconActivity,
  IconAdjustments,
  IconBolt,
  IconBrain,
  IconCheck,
  IconFlask,
  IconKey,
  IconPlayerPlay,
  IconPlugConnected,
  IconRefresh,
  IconSearch,
  IconPresentation,
  IconRobot,
  IconRoute,
  IconSettings,
  IconShield,
  IconTrash,
  IconUsers,
} from '@tabler/icons-react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useUnsavedWork } from '../unsaved-work';
import { api, json, type GatewayCandidate } from '../api';
import { msg, useTranslation } from '../i18n';

type Settings = Record<string, Record<string, any>>;
interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  email: string;
  role: string;
  teamName: string;
  active: boolean;
  createdAt: string;
}
interface Audit {
  id: number;
  action: string;
  resourceType: string;
  resourceId: string;
  actor: string;
  createdAt: string;
}
interface EvalCase {
  id: string;
  name: string;
  dreamType: string;
  inputNotes: string[];
  expectedTerms: string[];
  forbiddenTerms: string[];
  active: boolean;
  createdAt: string;
  latestRun?: {
    id: string;
    status: string;
    score: number;
    model: string;
    promptVersion: string;
    content: string;
    details: Record<string, any>;
    latencyMs: number;
    createdAt: string;
  };
}

interface EmbeddingQuality {
  algorithm: string;
  model: string;
  classes: { class: string; mean: number; min: number; max: number; count: number }[];
  discrimination: number;
  pairwiseAccuracy: number;
  pairs: number;
  topicSeparation: number;
  neighbourPurity: number;
  sentences: number;
  semantic: boolean;
  fellBack: boolean;
}

const menu = [
  ['overview', msg('운영 현황'), IconActivity],
  ['general', msg('일반'), IconSettings],
  ['oidc', 'Keycloak SSO', IconPlugConnected],
  ['dream', 'Dream Layer', IconBrain],
  ['ai_gateway', 'AI Gateway', IconRobot],
  ['ptium', msg('Ptium 발표 자료'), IconPresentation],
  ['intelligence', msg('유사도 기준'), IconAdjustments],
  ['ai_evals', msg('AI 품질 평가'), IconFlask],
  ['security', msg('키 · 권한'), IconShield],
  ['workflow', msg('검토 프로세스'), IconRoute],
  ['users', msg('사용자'), IconUsers],
  ['audit', msg('감사 로그'), IconAdjustments],
] as const;
type AdminSection = (typeof menu)[number][0];
const adminSections = new Set<AdminSection>(menu.map(([key]) => key));
const maxTokenLimit = 256 * 1024;
const isAdminSection = (value: string | undefined): value is AdminSection =>
  !!value && adminSections.has(value as AdminSection);
const settingChanged = (current?: Record<string, any>, saved?: Record<string, any>) =>
  JSON.stringify(current) !== JSON.stringify(saved);

export default function AdminPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const contentRef = useRef<HTMLElement>(null);
  const routeSection = location.pathname.split('/').filter(Boolean)[1];
  const section: AdminSection = isAdminSection(routeSection) ? routeSection : 'overview';
  const [settings, setSettings] = useState<Settings>({});
  const [savedSettings, setSavedSettings] = useState<Settings>({});
  const [metrics, setMetrics] = useState<Record<string, any>>({});
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [auditCursor, setAuditCursor] = useState('');
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditActions, setAuditActions] = useState<string[]>([]);
  const [auditFilter, setAuditFilter] = useState({ actor: '', action: '', resourceId: '' });
  const [keyStatus, setKeyStatus] = useState<Record<string, number | string>>({});
  const [evals, setEvals] = useState<EvalCase[]>([]);
  const [evalTypes, setEvalTypes] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      await Promise.all([
        api<Settings>('/admin/settings').then((value) => {
          setSettings(value);
          setSavedSettings(value);
        }),
        api<Record<string, any>>('/admin/metrics').then(setMetrics),
        api<{ users: AdminUser[] }>('/admin/users').then((v) => setUsers(v.users)),
        api<{ audit: Audit[]; nextCursor: string; actions?: string[] }>('/admin/audit?limit=100').then((v) => {
          setAudit(v.audit);
          setAuditCursor(v.nextCursor || '');
          setAuditActions(v.actions || []);
        }),
        api<Record<string, number | string>>('/admin/security/encryption').then(setKeyStatus),
        api<{ cases: EvalCase[]; dreamTypes: string[] }>('/admin/ai-evals').then((value) => {
          setEvals(value.cases);
          setEvalTypes(value.dreamTypes);
        }),
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('관리 정보를 불러오지 못했습니다.'));
    } finally {
      setLoading(false);
    }
  }, []);
  const dirtySections = useMemo(
    () => Object.keys(settings).filter((key) => settingChanged(settings[key], savedSettings[key])),
    [savedSettings, settings],
  );
  /*
   * Nothing was stopping an administrator walking away from work they had not
   * saved.
   *
   * Typing into a settings field and then clicking anything in the sidebar
   * discarded it silently: no warning on the way out, and no trace of it on the
   * way back — the field simply read what it had before. Worse than losing the
   * edit is not being told, because the card had shown the new value the whole
   * time it was being typed.
   *
   * Moving between admin sections is not leaving: the edits are kept and stay
   * marked, so only navigation out of /admin is worth interrupting.
   */
  /*
   * Somebody about to walk away from unsaved work is asked first.
   *
   * The question is registered rather than asked here, because the click that
   * loses the work happens in the shell's sidebar, not on this page. Moving
   * between admin sections is not leaving — those edits are kept and stay
   * marked — so only navigation out of /admin reaches this at all.
   */
  const { guard } = useUnsavedWork();
  const [leaving, setLeaving] = useState<((proceed: boolean) => void) | null>(null);
  useEffect(() => {
    if (dirtySections.length === 0) {
      guard(null);
      return;
    }
    guard(() => new Promise<boolean>((resolve) => setLeaving(() => resolve)));
    return () => guard(null);
  }, [dirtySections.length, guard]);

  // Closing the tab or reloading is the same loss by a different door, and only
  // the browser can interrupt that one.
  useEffect(() => {
    if (dirtySections.length === 0) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirtySections.length]);

  useEffect(() => {
    if (location.pathname !== `/admin/${section}`) navigate(`/admin/${section}`, { replace: true });
  }, [location.pathname, navigate, section]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    setMessage('');
    setError('');
  }, [section]);
  useEffect(() => {
    if (dirtySections.length === 0) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirtySections.length]);
  const update = (name: string, key: string, value: any) =>
    setSettings((all) => ({ ...all, [name]: { ...all[name], [key]: value } }));
  // Finding a gateway is the last piece of friction: an operator can know the
  // default is lexical and know a sidecar is running, and still be stuck on what
  // the model is called.
  const [found, setFound] = useState<GatewayCandidate[]>([]);
  const discoverGateways = async () => {
    setBusy('gateway-discover');
    try {
      const result = await api<{ gateways: GatewayCandidate[] }>('/admin/ai-gateway/discover');
      setFound(result.gateways);
      if (result.gateways.length === 0) {
        setMessage(t('알려진 주소에서 임베딩 게이트웨이를 찾지 못했습니다. 주소를 직접 입력해 주세요.'));
      }
    } finally {
      setBusy('');
    }
  };

  // Probing before saving separates the two failures an administrator can fix
  // here — wrong address, wrong model name — from the third, a working model
  // that is not semantic, which the quality panel answers.
  // Templates the last successful test found, so the template can be chosen by
  // name instead of an administrator pasting a UUID from another service.
  const [ptiumTemplates, setPtiumTemplates] = useState<{ id: string; name: string; kind?: string }[]>([]);
  const testPtium = async () => {
    const ptium = settings.ptium || {};
    setBusy('ptium-test');
    try {
      const result = await api<{
        ok: boolean;
        message?: string;
        templates?: { id: string; name: string; kind?: string }[];
      }>(
        '/admin/ptium/test',
        json('POST', {
          base_url: ptium.base_url || '',
          api_key: ptium.api_key || '',
          timeout_seconds: ptium.timeout_seconds || 0,
        }),
      );
      setPtiumTemplates(result.templates ?? []);
      setMessage(result.message || t('Ptium에 연결했습니다.'));
    } catch (cause) {
      setPtiumTemplates([]);
      setMessage(cause instanceof Error ? cause.message : t('Ptium 연결 실패'));
    } finally {
      setBusy('');
    }
  };

  const testGateway = async () => {
    const gateway = settings.ai_gateway || {};
    setBusy('gateway-test');
    try {
      const result = await api<{ ok: boolean; detail?: string; model?: string; dimensions?: number }>(
        '/admin/ai-gateway/test',
        json('POST', {
          base_url: gateway.base_url || '',
          embedding_model: gateway.embedding_model || '',
          embedding_base_url: gateway.embedding_base_url || '',
          api_key: gateway.api_key || '',
          embedding_api_key: gateway.embedding_api_key || '',
        }),
      );
      if (result.ok) {
        setMessage(
          t('연결됨 · {model} · {dimensions}차원', {
            model: result.model ?? '',
            dimensions: result.dimensions ?? 0,
          }),
        );
      } else {
        setMessage(t('연결 실패: {detail}', { detail: result.detail || '' }));
      }
    } finally {
      setBusy('');
    }
  };

  const save = async (name: string) => {
    setError('');
    try {
      await api(`/admin/settings/${name}`, json('PUT', settings[name]));
      setMessage(t('{section} 설정을 저장했습니다.', { section: t(menu.find((v) => v[0] === name)?.[1] || name) }));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('설정을 저장하지 못했습니다.'));
    }
  };
  const refresh = () => {
    if (dirtySections.length > 0 && !window.confirm(t('저장하지 않은 변경사항을 버리고 관리 정보를 새로고침할까요?')))
      return;
    void load();
  };
  const testOIDC = async () => {
    try {
      const v = await api<{ message: string }>('/admin/oidc/test', { method: 'POST' });
      setMessage(v.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('연결 실패'));
    }
  };
  const updateUser = async (user: AdminUser, patch: Partial<AdminUser>) => {
    const next = { ...user, ...patch };
    await api(
      `/admin/users/${user.id}`,
      json('PUT', { role: next.role, active: next.active, teamName: next.teamName || '' }),
    );
    setUsers((all) => all.map((v) => (v.id === user.id ? next : v)));
  };
  /* The filters as the server wants them, empty ones left out entirely. */
  const auditQuery = (using = auditFilter) => {
    const query = new URLSearchParams({ limit: '100' });
    if (using.actor.trim()) query.set('actor', using.actor.trim());
    if (using.action) query.set('action', using.action);
    if (using.resourceId.trim()) query.set('resourceId', using.resourceId.trim());
    return query;
  };
  /*
   * Takes the filter to use rather than reading it back from state.
   *
   * Clearing the filters sets them and searches in the same breath, and state
   * set a moment ago is not readable yet — so clearing searched with exactly
   * the conditions it had just removed, and the rows never changed.
   */
  const loadAudit = async (using = auditFilter) => {
    setAuditLoading(true);
    setError('');
    try {
      const value = await api<{ audit: Audit[]; nextCursor: string; actions?: string[] }>(
        `/admin/audit?${auditQuery(using)}`,
      );
      // Replaced rather than appended: this is a new question, not more of the
      // previous answer.
      setAudit(value.audit);
      setAuditCursor(value.nextCursor || '');
      if (value.actions) setAuditActions(value.actions);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('감사 로그를 불러오지 못했습니다.'));
    } finally {
      setAuditLoading(false);
    }
  };
  const loadMoreAudit = async () => {
    if (!auditCursor || auditLoading) return;
    setAuditLoading(true);
    setError('');
    try {
      const query = auditQuery();
      query.set('cursor', auditCursor);
      const value = await api<{ audit: Audit[]; nextCursor: string }>(`/admin/audit?${query}`);
      setAudit((all) => [...all, ...value.audit.filter((item) => !all.some((existing) => existing.id === item.id))]);
      setAuditCursor(value.nextCursor || '');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('감사 로그를 더 불러오지 못했습니다.'));
    } finally {
      setAuditLoading(false);
    }
  };
  const rotateEncryption = async () => {
    if (!window.confirm(t('기존 키로 암호화된 모든 설정, 웹훅 키와 AI 로그를 현재 키로 다시 암호화할까요?'))) return;
    try {
      const result = await api<{ rotated: number }>('/admin/security/encryption/rotate', { method: 'POST' });
      setMessage(t('{count}개의 암호문을 현재 키로 회전했습니다.', { count: result.rotated }));
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('암호화 키를 회전하지 못했습니다.'));
    }
  };
  return (
    <div className="admin-layout">
      <aside className="admin-menu nav-scroll" aria-label={t('관리자 메뉴')}>
        <Stack h="100%">
          <Group className="admin-brand" px="sm" pt={60}>
            <div className="brand-mark">um</div>
            <div>
              <Text fw={700}>Service Admin</Text>
              <Text className="admin-brand-caption" size="xs">
                umm control room
              </Text>
            </div>
          </Group>
          <Divider className="admin-divider" my="sm" />
          <ScrollArea className="nav-scroll" type="auto">
            <Stack gap={4}>
              {menu.map(([key, label, Icon]) => (
                <Button
                  component={NavLink}
                  to={`/admin/${key}`}
                  className="admin-menu-item"
                  data-active={section === key || undefined}
                  aria-current={section === key ? 'page' : undefined}
                  key={key}
                  fullWidth
                  justify="flex-start"
                  variant="subtle"
                  leftSection={<Icon size={18} />}
                  rightSection={
                    dirtySections.includes(key) ? (
                      <span className="admin-dirty-dot" aria-label={t('저장되지 않은 변경')} />
                    ) : undefined
                  }
                >
                  {label}
                </Button>
              ))}
            </Stack>
          </ScrollArea>
          <Text className="admin-menu-note" size="xs" mt="auto" px="sm">
            {t('모든 변경은 감사 로그에 기록됩니다.')}
          </Text>
        </Stack>
      </aside>
      <section ref={contentRef} className="admin-content nav-scroll">
        <Stack maw={1100} mx="auto" gap="xl">
          <Select
            className="admin-mobile-menu"
            label={t('관리 메뉴')}
            value={section}
            data={menu.map(([value, label]) => ({ value, label }))}
            onChange={(value) => value && navigate(`/admin/${value}`)}
          />
          <Group justify="space-between">
            <div>
              <Text size="xs" c="grape.7" fw={750}>
                SERVICE ADMINISTRATION
              </Text>
              <Group gap="sm" align="center">
                <Title order={1} mt={4}>
                  {menu.find((v) => v[0] === section)?.[1]}
                </Title>
                {dirtySections.includes(section) && (
                  <Badge color="yellow" variant="light">
                    {t('저장 안 됨')}
                  </Badge>
                )}
              </Group>
            </div>
            <Tooltip label={t('관리 정보 새로고침')}>
              <ActionIcon
                loading={loading}
                size="lg"
                variant="light"
                aria-label={t('관리 정보 새로고침')}
                onClick={refresh}
              >
                <IconRefresh size={19} />
              </ActionIcon>
            </Tooltip>
          </Group>
          {message && (
            <Alert color="green" icon={<IconCheck size={18} />} withCloseButton onClose={() => setMessage('')}>
              {message}
            </Alert>
          )}
          {error && (
            <Alert color="red" withCloseButton onClose={() => setError('')}>
              {error}
            </Alert>
          )}
          {section === 'overview' && (
            <Overview
              metrics={metrics}
              onRun={async () => {
                await api('/admin/dreams/run', { method: 'POST' });
                setMessage(t('Dream 작업을 큐에 등록했습니다.'));
              }}
            />
          )}
          {section === 'general' && settings.general && (
            <SettingCard
              dirty={settingChanged(settings.general, savedSettings.general)}
              title={t('서비스 기본 정보')}
              description={t('재시작 없이 적용되며 로그인 화면과 서비스 전반에 반영됩니다.')}
              onSave={() => save('general')}
            >
              <TextInput
                label={t('서비스 이름')}
                value={settings.general.service_name || ''}
                onChange={(e) => update('general', 'service_name', e.currentTarget.value)}
              />
              <TextInput
                label={t('공개 URL')}
                description={t('OIDC Callback과 Origin 검증에 사용합니다.')}
                value={settings.general.public_url || ''}
                onChange={(e) => update('general', 'public_url', e.currentTarget.value)}
              />
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <NumberInput
                  label={t('세션 유지 시간')}
                  suffix={t(' 시간')}
                  min={1}
                  max={720}
                  value={settings.general.session_hours || 24}
                  onChange={(v) => update('general', 'session_hours', v)}
                />
                <TextInput
                  label={t('서비스 시간대')}
                  placeholder="Asia/Seoul"
                  value={settings.general.timezone || ''}
                  onChange={(e) => update('general', 'timezone', e.currentTarget.value)}
                />
              </SimpleGrid>
            </SettingCard>
          )}
          {section === 'oidc' && settings.oidc && (
            <SettingCard
              dirty={settingChanged(settings.oidc, savedSettings.oidc)}
              title="Keycloak SSO · OIDC"
              description={t('Issuer URL, Client ID, Client Secret만으로 Discovery를 통해 자동 연결합니다.')}
              onSave={() => save('oidc')}
              actions={
                <Button variant="light" leftSection={<IconBolt size={16} />} onClick={() => void testOIDC()}>
                  {t('연결 시험')}
                </Button>
              }
            >
              <Switch
                size="lg"
                label={t('Keycloak SSO 활성화')}
                checked={!!settings.oidc.enabled}
                onChange={(e) => update('oidc', 'enabled', e.currentTarget.checked)}
              />
              <TextInput
                label="Issuer URL"
                placeholder="https://keycloak.internal/realms/umm"
                value={settings.oidc.issuer_url || ''}
                onChange={(e) => update('oidc', 'issuer_url', e.currentTarget.value)}
              />
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <TextInput
                  label="Client ID"
                  value={settings.oidc.client_id || ''}
                  onChange={(e) => update('oidc', 'client_id', e.currentTarget.value)}
                />
                <PasswordInput
                  label="Client Secret"
                  value={settings.oidc.client_secret || ''}
                  onChange={(e) => update('oidc', 'client_secret', e.currentTarget.value)}
                />
                <TextInput
                  label={t('관리자 그룹/역할')}
                  value={settings.oidc.admin_group || ''}
                  onChange={(e) => update('oidc', 'admin_group', e.currentTarget.value)}
                />
                <TextInput
                  label={t('팀장 그룹/역할')}
                  value={settings.oidc.team_lead_group || ''}
                  onChange={(e) => update('oidc', 'team_lead_group', e.currentTarget.value)}
                />
              </SimpleGrid>
              <Alert color="blue">
                {t('Keycloak Confidential Client에서 Standard Flow를 켜고 Callback을')}{' '}
                <b>{settings.general?.public_url}/api/v1/auth/oidc/callback</b>
                {t('으로 정확히 등록하세요.')}
              </Alert>
            </SettingCard>
          )}
          {section === 'dream' && settings.dream && (
            <DreamSettings
              dirty={settingChanged(settings.dream, savedSettings.dream)}
              value={settings.dream}
              update={(k, v) => update('dream', k, v)}
              save={() => save('dream')}
            />
          )}
          {section === 'ptium' && settings.ptium && (
            <SettingCard
              dirty={settingChanged(settings.ptium, savedSettings.ptium)}
              title={t('Ptium 연결')}
              description={t(
                '생각을 발표 자료로 만들 Ptium 서버입니다. 비워 두면 이 기능이 꺼집니다. umm은 Ptium에 생각을 그대로 보내며, 모델에게 다시 쓰게 하지 않습니다.',
              )}
              onSave={() => save('ptium')}
              actions={
                <Button
                  size="xs"
                  variant="light"
                  leftSection={<IconPlugConnected size={14} />}
                  loading={busy === 'ptium-test'}
                  onClick={() => void testPtium()}
                >
                  {t('연결 테스트')}
                </Button>
              }
            >
              <TextInput
                label="Base URL"
                description={t('Ptium 서버 주소입니다. 예: http://ptium.internal:8080')}
                placeholder="http://ptium.internal:8080"
                value={settings.ptium.base_url || ''}
                onChange={(e) => update('ptium', 'base_url', e.currentTarget.value)}
              />
              <PasswordInput
                label="API Key"
                description={t(
                  'Ptium에서 발급한 ptium_ 로 시작하는 키입니다. presentations 읽기·쓰기 권한이 필요합니다.',
                )}
                value={settings.ptium.api_key || ''}
                onChange={(e) => update('ptium', 'api_key', e.currentTarget.value)}
              />
              {/* Offered by name once a test has found them. A UUID pasted from
                  another service is the kind of setting that looks saved and
                  turns out to name nothing. */}
              {ptiumTemplates.length > 0 ? (
                <Select
                  label={t('템플릿')}
                  description={t('비워 두면 Ptium의 기본 디자인을 씁니다.')}
                  placeholder={t('Ptium 기본 디자인')}
                  clearable
                  data={ptiumTemplates.map((template) => ({ value: template.id, label: template.name }))}
                  value={settings.ptium.template_id || null}
                  onChange={(value) => update('ptium', 'template_id', value || '')}
                />
              ) : (
                <TextInput
                  label={t('템플릿 ID')}
                  description={t(
                    '비워 두면 Ptium의 기본 디자인을 씁니다. 연결 테스트를 하면 목록에서 고를 수 있습니다.',
                  )}
                  value={settings.ptium.template_id || ''}
                  onChange={(e) => update('ptium', 'template_id', e.currentTarget.value)}
                />
              )}
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <TextInput
                  label={t('언어')}
                  description={t('Ptium이 덱을 만들 때 쓰는 언어 코드입니다.')}
                  placeholder="ko"
                  value={settings.ptium.language || ''}
                  onChange={(e) => update('ptium', 'language', e.currentTarget.value)}
                />
                <NumberInput
                  label="Timeout"
                  description={t('덱을 컴파일하는 데 걸리는 시간입니다.')}
                  suffix={t(' 초')}
                  min={5}
                  max={300}
                  value={settings.ptium.timeout_seconds}
                  onChange={(v) => update('ptium', 'timeout_seconds', v)}
                />
              </SimpleGrid>
            </SettingCard>
          )}
          {section === 'ai_gateway' && settings.ai_gateway && (
            <SettingCard
              dirty={settingChanged(settings.ai_gateway, savedSettings.ai_gateway)}
              title={t('내부 AI Gateway')}
              description={t(
                'OpenAI 호환 Chat Completions 엔드포인트를 사용합니다. 외부 연결 없이 내부 모델 서버를 지정할 수 있습니다.',
              )}
              onSave={() => save('ai_gateway')}
            >
              <TextInput
                label="Base URL"
                description={t('서버 주소, /v1 주소 또는 전체 /chat/completions 주소를 사용할 수 있습니다.')}
                placeholder="http://llm-gateway.internal:8000/v1"
                value={settings.ai_gateway.base_url || ''}
                onChange={(e) => update('ai_gateway', 'base_url', e.currentTarget.value)}
              />
              <PasswordInput
                label="API Key"
                value={settings.ai_gateway.api_key || ''}
                onChange={(e) => update('ai_gateway', 'api_key', e.currentTarget.value)}
              />
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <NumberInput
                  label="Timeout"
                  description={t('긴 추론 모델은 충분한 시간을 지정하세요.')}
                  suffix={t(' 초')}
                  min={5}
                  max={1800}
                  value={settings.ai_gateway.timeout_seconds}
                  onChange={(v) => update('ai_gateway', 'timeout_seconds', v)}
                />
                <NumberInput
                  label={t('재시도')}
                  description={t('1 이상이면 추론만 생성된 응답을 비추론 모드로 복구합니다.')}
                  min={0}
                  max={5}
                  value={settings.ai_gateway.max_retries}
                  onChange={(v) => update('ai_gateway', 'max_retries', v)}
                />
                <NumberInput
                  label={t('입력 $ / 1M token')}
                  min={0}
                  decimalScale={4}
                  value={settings.ai_gateway.input_cost_per_million}
                  onChange={(v) => update('ai_gateway', 'input_cost_per_million', v)}
                />
                <NumberInput
                  label={t('출력 $ / 1M token')}
                  min={0}
                  decimalScale={4}
                  value={settings.ai_gateway.output_cost_per_million}
                  onChange={(v) => update('ai_gateway', 'output_cost_per_million', v)}
                />
                <NumberInput
                  label={t('AI 로그 보존')}
                  suffix={t(' 일')}
                  min={1}
                  max={3650}
                  value={settings.ai_gateway.log_retention_days || 90}
                  onChange={(v) => update('ai_gateway', 'log_retention_days', v)}
                />
              </SimpleGrid>
              <TextInput
                label="Prompt Version"
                value={settings.ai_gateway.prompt_version || ''}
                onChange={(e) => update('ai_gateway', 'prompt_version', e.currentTarget.value)}
              />
              <Group justify="flex-end">
                <Button
                  size="xs"
                  variant="subtle"
                  leftSection={<IconSearch size={14} />}
                  loading={busy === 'gateway-discover'}
                  onClick={() => void discoverGateways()}
                >
                  {t('자동으로 찾기')}
                </Button>
                <Button
                  size="xs"
                  variant="light"
                  leftSection={<IconPlugConnected size={14} />}
                  loading={busy === 'gateway-test'}
                  onClick={() => void testGateway()}
                >
                  {t('연결 테스트')}
                </Button>
              </Group>
              {found.length > 0 && (
                <Paper withBorder radius="md" p="sm">
                  <Text size="xs" c="dimmed" mb={6}>
                    {t(
                      '이름으로 짐작한 임베딩 모델을 먼저 보여 줍니다. 실제로 임베딩하는지는 연결 테스트가 확인합니다.',
                    )}
                  </Text>
                  <Stack gap={6}>
                    {found.map((gateway) => (
                      <div key={gateway.baseUrl}>
                        <Code>{gateway.baseUrl}</Code>
                        <Group gap={6} mt={4} wrap="wrap">
                          {gateway.models.map((model) => (
                            <Button
                              key={model.name}
                              size="compact-xs"
                              variant={model.likelyEmbedding ? 'light' : 'subtle'}
                              color={model.likelyEmbedding ? 'grape' : 'gray'}
                              onClick={() => {
                                // The embedding address, not the chat one. This
                                // used to overwrite Base URL, which was right
                                // when both shared a field and would now point
                                // the chat model at an embeddings-only server.
                                update('ai_gateway', 'embedding_base_url', gateway.baseUrl);
                                update('ai_gateway', 'embedding_model', model.name);
                                setFound([]);
                              }}
                            >
                              {model.name}
                            </Button>
                          ))}
                        </Group>
                      </div>
                    ))}
                  </Stack>
                </Paper>
              )}
              <TextInput
                label={t('임베딩 모델')}
                description={t(
                  '비워 두면 외부 호출 없이 내장 로컬 임베딩을 사용합니다. 모델을 바꾸면 생각이 점진적으로 다시 임베딩됩니다.',
                )}
                placeholder="text-embedding-3-small"
                value={settings.ai_gateway.embedding_model || ''}
                onChange={(e) => update('ai_gateway', 'embedding_model', e.currentTarget.value)}
              />
              <TextInput
                label={t('임베딩 Gateway 주소')}
                description={t('비워 두면 위의 Base URL을 씁니다. 임베딩 서버를 따로 두었다면 여기에 적으세요.')}
                placeholder="http://embeddings:11434"
                value={settings.ai_gateway.embedding_base_url || ''}
                onChange={(e) => update('ai_gateway', 'embedding_base_url', e.currentTarget.value)}
              />
              <PasswordInput
                label={t('임베딩 API Key')}
                description={t(
                  '임베딩 Gateway 주소를 적으면 위의 API Key는 그쪽으로 보내지 않습니다. 인증이 필요 없으면 비워 두세요.',
                )}
                value={settings.ai_gateway.embedding_api_key || ''}
                onChange={(e) => update('ai_gateway', 'embedding_api_key', e.currentTarget.value)}
              />
              <EmbeddingQualityPanel />
              <Switch
                label={t('원문 Prompt 로그 저장')}
                description={t('기본 OFF입니다. ON이면 민감 패턴 제거 후 암호화해 보존 기간 동안만 저장합니다.')}
                checked={!!settings.ai_gateway.log_prompt}
                onChange={(e) => update('ai_gateway', 'log_prompt', e.currentTarget.checked)}
              />
            </SettingCard>
          )}
          {section === 'intelligence' && settings.intelligence && (
            <SettingCard
              dirty={settingChanged(settings.intelligence, savedSettings.intelligence)}
              title={t('유사도 판정 기준')}
              description={t(
                '연관 생각·군집·검색·자동 연결이 무엇을 "가깝다"고 볼지 정합니다. 기본값은 umm이 실제로 측정해 정한 값이며, 바꾸지 않으면 그대로 동작합니다.',
              )}
              onSave={() => save('intelligence')}
            >
              <Alert color="blue" variant="light">
                {t(
                  '기준은 코사인 값이 아니라 "그 후보 집합의 평균에서 표준편차 몇 개 위인가"입니다. 그래서 임베딩 모델을 바꿔도 같은 뜻을 유지합니다.',
                )}
              </Alert>
              <SimpleGrid cols={{ base: 1, sm: 3 }}>
                <NumberInput
                  label={t('연관 생각 기준')}
                  description={t('기본 0.6 · 낮을수록 더 많이 연관으로 봅니다')}
                  min={0}
                  max={4}
                  step={0.1}
                  decimalScale={2}
                  value={settings.intelligence.related_band}
                  onChange={(v) => update('intelligence', 'related_band', v)}
                />
                <NumberInput
                  label={t('군집 기준')}
                  description={t('기본 1.1 · 한 주제로 묶는 문턱')}
                  min={0}
                  max={4}
                  step={0.1}
                  decimalScale={2}
                  value={settings.intelligence.cluster_band}
                  onChange={(v) => update('intelligence', 'cluster_band', v)}
                />
                <NumberInput
                  label={t('강한 일치 기준')}
                  description={t('기본 0.9 · 검색에 "의미상 유사" 라벨을 붙이는 문턱')}
                  min={0}
                  max={4}
                  step={0.1}
                  decimalScale={2}
                  value={settings.intelligence.strong_band}
                  onChange={(v) => update('intelligence', 'strong_band', v)}
                />
              </SimpleGrid>

              <Divider label={t('자동 연결')} labelPosition="left" mt="md" />
              <Switch
                label={t('umm이 연결을 먼저 제안')}
                description={t('끄면 그래프에는 사람과 에이전트가 넣은 연결만 남습니다.')}
                checked={!!settings.intelligence.autolink_enabled}
                onChange={(e) => update('intelligence', 'autolink_enabled', e.currentTarget.checked)}
              />
              <SimpleGrid cols={{ base: 1, sm: 3 }}>
                <NumberInput
                  label={t('제안 기준')}
                  description={t('기본 1.1 · 연관으로 보는 것보다 높게 둡니다')}
                  min={0}
                  max={4}
                  step={0.1}
                  decimalScale={2}
                  value={settings.intelligence.autolink_band}
                  onChange={(v) => update('intelligence', 'autolink_band', v)}
                />
                <NumberInput
                  label={t('한 번에 제안할 최대 개수')}
                  description={t('기본 12 · 많이 쌓이면 전부 무시하게 됩니다')}
                  min={1}
                  max={100}
                  value={settings.intelligence.autolink_max_per_run}
                  onChange={(v) => update('intelligence', 'autolink_max_per_run', v)}
                />
                <NumberInput
                  label={t('필요한 최소 메모 수')}
                  description={t('기본 6 · 이보다 적으면 판단하지 않습니다')}
                  min={3}
                  max={1000}
                  value={settings.intelligence.autolink_min_notes}
                  onChange={(v) => update('intelligence', 'autolink_min_notes', v)}
                />
              </SimpleGrid>

              <Divider label={t('임베딩 판정 관문')} labelPosition="left" mt="md" />
              <Alert color="yellow" variant="light">
                {t(
                  '이 값을 낮추면 뜻보다 겹치는 단어를 높게 보는 백엔드에서도 자동 연결이 실행됩니다. 단, 어휘가 뜻을 앞서는 백엔드는 어떤 값으로도 통과하지 못합니다 — 그건 설정이 아니라 바닥입니다.',
                )}
              </Alert>
              <Text size="xs" c="dimmed">
                {t(
                  '중복 판정만 표준편차가 아니라 코사인 절대값을 씁니다. 거의 같은 글은 어떤 임베딩에서도 맨 위에 오고 두 모델이 같은 지점에 두기 때문입니다 — 측정값으로 bge-m3는 0.943 이상, paraphrase-multilingual은 0.954 이상이며 그다음 등급은 0.681에서 끝납니다.',
                )}
              </Text>
              <SimpleGrid cols={{ base: 1, sm: 3 }}>
                <NumberInput
                  label={t('쌍별 정확도 하한')}
                  description={t('기본 0.65 · 내장 임베딩은 0.042')}
                  min={0}
                  max={1}
                  step={0.05}
                  decimalScale={2}
                  value={settings.intelligence.semantic_accuracy_bar}
                  onChange={(v) => update('intelligence', 'semantic_accuracy_bar', v)}
                />
                <NumberInput
                  label={t('최근접 동일 주제 하한')}
                  description={t('기본 0.6 · 내장 임베딩은 0.188')}
                  min={0}
                  max={1}
                  step={0.05}
                  decimalScale={2}
                  value={settings.intelligence.semantic_purity_bar}
                  onChange={(v) => update('intelligence', 'semantic_purity_bar', v)}
                />
                <NumberInput
                  label={t('중복 판정 기준')}
                  description={t('기본 0.92 · 이 값만 코사인 절대값입니다')}
                  min={0.7}
                  max={1}
                  step={0.01}
                  decimalScale={2}
                  value={settings.intelligence.duplicate_similarity}
                  onChange={(v) => update('intelligence', 'duplicate_similarity', v)}
                />
                <NumberInput
                  label={t('측정 결과 보관(분)')}
                  description={t('기본 10 · 측정 한 번은 문장 60개 임베딩 요청입니다')}
                  min={1}
                  max={1440}
                  value={settings.intelligence.quality_cache_minutes}
                  onChange={(v) => update('intelligence', 'quality_cache_minutes', v)}
                />
              </SimpleGrid>
            </SettingCard>
          )}
          {section === 'ai_evals' && <AIEvals cases={evals} dreamTypes={evalTypes} reload={load} notify={setMessage} />}
          {section === 'security' && settings.security && (
            <>
              <SettingCard
                dirty={settingChanged(settings.security, savedSettings.security)}
                title={t('개인 키 권한 체계')}
                description={t('사용자가 자신의 키에 부여할 수 있는 권한과 회전 정책입니다.')}
                onSave={() => save('security')}
              >
                <TagsInput
                  label={t('허용 API/MCP Scopes')}
                  value={settings.security.api_key_scopes || []}
                  onChange={(v) => update('security', 'api_key_scopes', v)}
                  splitChars={[',', ' ']}
                />
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <NumberInput
                    label={t('기본 키 만료')}
                    suffix={t(' 일')}
                    min={1}
                    max={3650}
                    value={settings.security.default_key_days}
                    onChange={(v) => update('security', 'default_key_days', v)}
                  />
                  <NumberInput
                    label={t('회전 중첩 시간')}
                    suffix={t(' 시간')}
                    min={0}
                    max={168}
                    value={settings.security.rotation_overlap_hours}
                    onChange={(v) => update('security', 'rotation_overlap_hours', v)}
                  />
                </SimpleGrid>
              </SettingCard>
              <SettingCard
                dirty={settingChanged(settings.security, savedSettings.security)}
                title={t('남용 방지')}
                description={t('로그인 실패와 요청 폭주로부터 서비스를 보호합니다. 값은 즉시 적용됩니다.')}
                onSave={() => save('security')}
              >
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <NumberInput
                    label={t('로그인 실패 허용 횟수')}
                    min={3}
                    max={100}
                    value={settings.security.login_max_failures ?? 8}
                    onChange={(v) => update('security', 'login_max_failures', v)}
                  />
                  <NumberInput
                    label={t('로그인 잠금 시간')}
                    suffix={t(' 분')}
                    min={1}
                    max={1440}
                    value={settings.security.login_lockout_minutes ?? 15}
                    onChange={(v) => update('security', 'login_lockout_minutes', v)}
                  />
                  <NumberInput
                    label={t('분당 API 요청')}
                    min={30}
                    max={100000}
                    value={settings.security.api_rate_per_minute ?? 600}
                    onChange={(v) => update('security', 'api_rate_per_minute', v)}
                  />
                  <NumberInput
                    label={t('분당 AI 요청')}
                    min={1}
                    max={600}
                    value={settings.security.ai_rate_per_minute ?? 6}
                    onChange={(v) => update('security', 'ai_rate_per_minute', v)}
                  />
                  <NumberInput
                    label={t('하루 AI 생성 한도')}
                    description={t('0이면 제한하지 않습니다.')}
                    min={0}
                    max={100000}
                    value={settings.security.ai_daily_limit ?? 80}
                    onChange={(v) => update('security', 'ai_daily_limit', v)}
                  />
                </SimpleGrid>
              </SettingCard>
              <Card radius="lg" p="xl" withBorder>
                <Group justify="space-between" align="flex-start">
                  <div>
                    <Group gap="xs">
                      <IconKey />
                      <Title order={2} fz="xl">
                        Master encryption key
                      </Title>
                    </Group>
                    <Text c="dimmed" mt={5}>
                      {t('새 기본 키와 이전 키를 함께 기동한 뒤 무중단으로 암호문을 재암호화합니다.')}
                    </Text>
                  </div>
                  <Button
                    disabled={Number(keyStatus.fallbackKeys || 0) < 1 || Number(keyStatus.pendingRotation || 0) < 1}
                    onClick={() => void rotateEncryption()}
                  >
                    {t('현재 키로 회전')}
                  </Button>
                </Group>
                <SimpleGrid cols={{ base: 2, sm: 4 }} mt="xl">
                  <Metric label={t('현재 Key ID')} value={String(keyStatus.keyId || '-')} />
                  <Metric label={t('이전 키')} value={t('{count}개', { count: keyStatus.fallbackKeys || 0 })} />
                  <Metric label={t('회전 대기')} value={t('{count}개', { count: keyStatus.pendingRotation || 0 })} />
                  <Metric label={t('읽기 실패')} value={t('{count}개', { count: keyStatus.unreadable || 0 })} />
                </SimpleGrid>
                {Number(keyStatus.fallbackKeys || 0) === 0 && (
                  <Alert color="blue" mt="lg">
                    {t('회전할 때만 새')} <Code>ENCRYPTION_KEY</Code> {t('와 기존 값을')}{' '}
                    <Code>ENCRYPTION_KEY_PREVIOUS</Code>
                    {t('에 넣고 재시작하세요.')}
                  </Alert>
                )}
              </Card>
            </>
          )}
          {section === 'workflow' && settings.workflow && (
            <SettingCard
              dirty={settingChanged(settings.workflow, savedSettings.workflow)}
              title={t('팀장 검토 · 승인')}
              description={t('활성화한 작업에만 승인/반려 단계를 삽입합니다. OFF이면 프로세스 자체가 제외됩니다.')}
              onSave={() => save('workflow')}
            >
              <Switch
                size="lg"
                label={t('검토 프로세스 활성화')}
                checked={!!settings.workflow.enabled}
                onChange={(e) => update('workflow', 'enabled', e.currentTarget.checked)}
              />
              <Checkbox.Group
                label={t('승인이 필요한 작업')}
                value={settings.workflow.actions || []}
                onChange={(v) => update('workflow', 'actions', v)}
              >
                <Stack mt="sm">
                  <Checkbox value="space_share" label={t('팀 공간 공유')} />
                  <Checkbox value="export" label={t('외부 내보내기')} />
                </Stack>
              </Checkbox.Group>
            </SettingCard>
          )}
          {section === 'users' && <Users users={users} update={updateUser} />}{' '}
          {section === 'audit' && (
            <AuditTable
              entries={audit}
              nextCursor={auditCursor}
              loading={auditLoading}
              onMore={loadMoreAudit}
              actions={auditActions}
              filter={auditFilter}
              onFilter={setAuditFilter}
              onSearch={loadAudit}
            />
          )}
        </Stack>
      </section>

      <Modal
        opened={leaving !== null}
        onClose={() => {
          leaving?.(false);
          setLeaving(null);
        }}
        title={t('저장하지 않은 변경사항이 있습니다')}
        centered
      >
        <Stack gap="md">
          <Text size="sm">
            {t('{sections}에서 바꾼 내용이 아직 저장되지 않았습니다. 지금 나가면 그대로 사라집니다.', {
              sections: dirtySections.map((key) => sectionTitle(key, t)).join(', '),
            })}
          </Text>
          <Group justify="flex-end" gap="xs">
            {/* Staying is the first button and the one that keeps the work, so
                a person who is not reading closely does the recoverable thing. */}
            <Button
              variant="default"
              onClick={() => {
                leaving?.(false);
                setLeaving(null);
              }}
            >
              {t('여기 남기')}
            </Button>
            <Button
              color="red"
              variant="light"
              onClick={() => {
                leaving?.(true);
                setLeaving(null);
              }}
            >
              {t('버리고 나가기')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </div>
  );
}

/** The name a section is called in the menu, so a warning names what it means. */
function sectionTitle(key: string, t: (value: string) => string): string {
  const found = menu.find(([name]) => name === key);
  return found ? t(found[1]) : key;
}

function SettingCard({
  title,
  description,
  children,
  onSave,
  actions,
  dirty,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  onSave: () => void;
  actions?: React.ReactNode;
  dirty?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Card className="admin-setting-card" radius="lg" p={{ base: 'lg', sm: 'xl' }} withBorder>
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={2} fz="xl">
            {title}
          </Title>
          <Text c="dimmed" mt={5}>
            {description}
          </Text>
        </div>
        {actions}
      </Group>
      <Divider my="xl" />
      <Stack gap="lg">
        {children}
        <Group className="admin-save-bar" justify="space-between">
          <Text size="sm" c={dirty ? 'yellow.8' : 'dimmed'}>
            {dirty ? t('저장되지 않은 변경사항이 있습니다.') : t('모든 변경사항이 저장되었습니다.')}
          </Text>
          <Button disabled={!dirty} onClick={onSave}>
            {t('저장')}
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}

function DreamSettings({
  value,
  update,
  save,
  dirty,
}: {
  value: Record<string, any>;
  update: (k: string, v: any) => void;
  save: () => void;
  dirty: boolean;
}) {
  const { t } = useTranslation();
  const weekdays = [
    { value: '1', label: t('월') },
    { value: '2', label: t('화') },
    { value: '3', label: t('수') },
    { value: '4', label: t('목') },
    { value: '5', label: t('금') },
    { value: '6', label: t('토') },
    { value: '7', label: t('일') },
  ];
  const tokenPresets = [4096, 16384, 65536, 131072, maxTokenLimit];
  return (
    <SettingCard
      dirty={dirty}
      title="Dream Settings"
      description={t('좋은 Dream이 없으면 생성하지 않는 것을 기본 원칙으로 합니다.')}
      onSave={save}
    >
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Switch
          size="lg"
          label={t('Dream 기능')}
          checked={!!value.enabled}
          onChange={(e) => update('enabled', e.currentTarget.checked)}
        />
        <Switch
          size="lg"
          label={t('자동 생성')}
          checked={!!value.automatic}
          onChange={(e) => update('automatic', e.currentTarget.checked)}
        />
        <TextInput
          label={t('생성 시간')}
          type="time"
          value={value.schedule || '02:00'}
          onChange={(e) => update('schedule', e.currentTarget.value)}
        />
        <Select
          label={t('생성 주기')}
          value={value.frequency || 'daily'}
          data={[
            { value: 'daily', label: t('매일') },
            { value: 'weekdays', label: t('평일') },
            { value: 'weekends', label: t('주말') },
            { value: 'custom', label: t('특정 요일') },
            { value: 'interval', label: t('N일 간격') },
          ]}
          onChange={(v) => v && update('frequency', v)}
        />
        {value.frequency === 'interval' && (
          <NumberInput
            label={t('생성 간격')}
            suffix={t(' 일마다')}
            min={2}
            max={365}
            value={value.interval_days || 2}
            onChange={(v) => update('interval_days', v)}
          />
        )}
        <NumberInput
          label={t('사용자당 Dream')}
          suffix={t(' 장')}
          min={1}
          max={3}
          value={value.count}
          onChange={(v) => update('count', v)}
        />
        <NumberInput
          label={t('최소 메모')}
          suffix={t(' 개')}
          min={2}
          max={100}
          value={value.min_notes}
          onChange={(v) => update('min_notes', v)}
        />
        <NumberInput
          label={t('최근 분석 범위')}
          suffix={t(' 일')}
          min={1}
          max={365}
          value={value.context_days}
          onChange={(v) => update('context_days', v)}
        />
        <NumberInput
          label={t('최대 Context 메모')}
          suffix={t(' 개')}
          min={2}
          max={100}
          value={value.max_context_notes}
          onChange={(v) => update('max_context_notes', v)}
        />
        <TextInput label="Model" value={value.model || ''} onChange={(e) => update('model', e.currentTarget.value)} />
        <Stack gap="xs">
          <NumberInput
            label={t('최대 응답 Token')}
            description={t('추론 토큰을 포함한 최대 출력 한도입니다.')}
            min={64}
            max={maxTokenLimit}
            step={1024}
            thousandSeparator=","
            allowDecimal={false}
            value={value.token_limit}
            onChange={(v) => typeof v === 'number' && update('token_limit', Math.trunc(v))}
          />
          <Group gap={5}>
            {tokenPresets.map((tokens) => (
              <Button
                key={tokens}
                size="compact-xs"
                variant={Number(value.token_limit) === tokens ? 'filled' : 'light'}
                onClick={() => update('token_limit', tokens)}
              >
                {tokens === maxTokenLimit ? '256K' : `${Math.round(tokens / 1024)}K`}
              </Button>
            ))}
          </Group>
        </Stack>
        <NumberInput
          label={t('월 사용자 호출 제한')}
          min={1}
          max={1000}
          value={value.monthly_limit}
          onChange={(v) => update('monthly_limit', v)}
        />
        <Switch
          label={t('사용자 개별 OFF 허용')}
          checked={!!value.allow_user_disable}
          onChange={(e) => update('allow_user_disable', e.currentTarget.checked)}
        />
        <Switch
          label={t('Dream 도착 알림 허용')}
          checked={!!value.notification}
          onChange={(e) => update('notification', e.currentTarget.checked)}
        />
      </SimpleGrid>
      <Alert color={Number(value.token_limit) >= 131072 ? 'yellow' : 'blue'}>
        {t(
          '모델이 지원하는 최대 출력과 Context Window를 초과하면 Gateway가 요청을 거부할 수 있습니다. 큰 한도는 응답 시간과 비용도 늘리므로 모델 사양에 맞춰 선택하세요.',
        )}
      </Alert>
      {value.frequency === 'custom' && (
        <Checkbox.Group
          label={t('Dream 생성 요일')}
          value={(value.custom_days || [1, 3, 5]).map(String)}
          onChange={(days) => update('custom_days', days.map(Number))}
        >
          <Group mt="sm">
            {weekdays.map((day) => (
              <Checkbox key={day.value} value={day.value} label={day.label} />
            ))}
          </Group>
        </Checkbox.Group>
      )}
      <div>
        <Group justify="space-between">
          <Text fw={550}>Creativity</Text>
          <Text>{Number(value.temperature).toFixed(1)}</Text>
        </Group>
        <Slider
          min={0}
          max={1.5}
          step={0.1}
          value={value.temperature}
          onChange={(v) => update('temperature', v)}
          mt="sm"
        />
      </div>
      <div>
        <Group justify="space-between">
          <Text fw={550}>{t('Dream 노출 최소 Score')}</Text>
          <Text>{Math.round(value.quality_threshold * 100)}%</Text>
        </Group>
        <Slider
          min={0}
          max={1}
          step={0.05}
          color="grape"
          value={value.quality_threshold}
          onChange={(v) => update('quality_threshold', v)}
          mt="sm"
        />
      </div>
      <Switch
        label="Quiet Mode"
        description={t('가치가 높은 경우에만 생성')}
        checked={!!value.quiet_mode}
        onChange={(e) => update('quiet_mode', e.currentTarget.checked)}
      />
    </SettingCard>
  );
}

function Overview({ metrics, onRun }: { metrics: Record<string, any>; onRun: () => void }) {
  const { t, formatNumber } = useTranslation();
  const d = metrics.dream || {};
  const realtime = metrics.realtime || {};
  const cards = [
    [t('전체 사용자'), metrics.users, IconUsers],
    [t('활성 사용자'), metrics.activeUsers, IconActivity],
    [t('생각'), metrics.notes, IconBrain],
    [t('공간'), metrics.spaces, IconAdjustments],
    [t('Dream 생성'), d.generatedDreams || 0, IconMoon],
    [t('AI 호출'), d.apiCalls || 0, IconBolt],
  ];
  return (
    <Stack>
      <SimpleGrid cols={{ base: 2, md: 3 }}>
        {cards.map(([label, value, Icon]: any) => (
          <Card key={label} radius="lg" withBorder>
            <Group justify="space-between">
              <Text c="dimmed" size="sm">
                {label}
              </Text>
              <Icon size={18} color="#8066a5" />
            </Group>
            <Text fz={30} fw={720} mt="sm">
              {formatNumber(Number(value || 0))}
            </Text>
          </Card>
        ))}
      </SimpleGrid>
      <Card radius="lg" p="xl" withBorder>
        <Group justify="space-between" align="flex-start">
          <div>
            <Title order={2} fz="xl">
              {t('실시간 협업')}
            </Title>
            <Text c="dimmed">{t('열려 있는 이벤트 구독과 PostgreSQL 수신 상태')}</Text>
          </div>
          <Badge color={realtime.listening ? 'green' : 'yellow'} variant="light" size="lg">
            {realtime.listening ? t('수신 대기') : t('폴백 폴링')}
          </Badge>
        </Group>
        <SimpleGrid cols={{ base: 2, sm: 3 }} mt="xl">
          <Metric label={t('연결된 구독')} value={formatNumber(Number(realtime.subscribers || 0))} />
          <Metric label={t('공간')} value={formatNumber(Number(realtime.spaces || 0))} />
          <Metric label={t('전달한 신호')} value={formatNumber(Number(realtime.delivered || 0))} />
        </SimpleGrid>
      </Card>
      <Card radius="lg" p="xl" withBorder>
        <Group justify="space-between">
          <div>
            <Title order={2} fz="xl">
              {t('Dream 운영')}
            </Title>
            <Text c="dimmed">{t('이번 달 채택·후속 활용과 현재 설정 기준 사전 예측')}</Text>
          </div>
          <Button leftSection={<IconBolt size={16} />} onClick={onRun}>
            {t('지금 큐 생성')}
          </Button>
        </Group>
        <SimpleGrid cols={{ base: 1, sm: 3 }} mt="xl">
          <Metric label={t('생성 조건 충족 사용자')} value={formatNumber(Number(d.eligibleUsers || 0))} />
          <Metric label={t('예상 월 호출')} value={formatNumber(Number(d.expectedMonthlyCalls || 0))} />
          <Metric
            label={t('예상 월 비용')}
            value={`$${((d.estimatedMonthlyCostMicros || 0) / 1_000_000).toFixed(2)}`}
          />
          <Metric label={t('검토 완료')} value={formatNumber(Number(d.reviewedDreams || 0))} />
          <Metric
            label={t('평균 내부 품질')}
            value={`${Math.round((d.avgQualityScore || 0) * 100)}%`}
            progress={(d.avgQualityScore || 0) * 100}
          />
          <Metric
            label={t('Dream 채택률')}
            value={`${Math.round((d.acceptanceRate || 0) * 100)}%`}
            progress={(d.acceptanceRate || 0) * 100}
          />
          <Metric
            label={t('유의미 활용률')}
            value={`${Math.round((d.meaningfulActionRate || 0) * 100)}%`}
            progress={(d.meaningfulActionRate || 0) * 100}
          />
          <Metric
            label={t('Dream 발전율')}
            value={`${Math.round((d.expansionRate || 0) * 100)}%`}
            progress={(d.expansionRate || 0) * 100}
          />
          <Metric
            label={t('Dream 숨김률')}
            value={`${Math.round((d.deleteRate || 0) * 100)}%`}
            progress={(d.deleteRate || 0) * 100}
          />
          <Metric label={t('재생성 요청')} value={formatNumber(Number(d.regeneratedCount || 0))} />
          <Metric label={t('입력 Token')} value={formatNumber(Number(d.inputTokens || 0))} />
          <Metric label={t('실제 비용')} value={`$${((d.costMicros || 0) / 1_000_000).toFixed(2)}`} />
          <Metric
            label={t('채택 Dream당 비용')}
            value={`$${((d.costPerAcceptedDreamMicros || 0) / 1_000_000).toFixed(4)}`}
          />
          <Metric
            label={t('활성 사용자당 비용')}
            value={`$${((d.costPerActiveUserMicros || 0) / 1_000_000).toFixed(4)}`}
          />
        </SimpleGrid>
      </Card>
    </Stack>
  );
}
// A configured embedding model that never took effect looks exactly like a
// working one: no error, no warning, and features that still say "related".
// This runs umm's own labelled measurement against whatever backend is live and
// shows the two numbers that decide whether "similar" means anything.
function EmbeddingQualityPanel() {
  const { t } = useTranslation();
  const [report, setReport] = useState<EmbeddingQuality | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const measure = useCallback(async (refresh: boolean) => {
    setBusy(true);
    setFailed(false);
    try {
      setReport(await api<EmbeddingQuality>(`/admin/embedding-quality${refresh ? '?refresh=true' : ''}`));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void measure(false);
  }, [measure]);

  const classLabels: Record<string, string> = {
    paraphrase: t('같은 뜻, 다른 표현'),
    related: t('같은 주제, 다른 주장'),
    'lexical-decoy': t('단어만 겹침 (함정)'),
    unrelated: t('무관'),
  };

  return (
    <Card withBorder radius="md" padding="md" mt="xs">
      <Group justify="space-between" mb="xs" wrap="nowrap">
        <div>
          <Text fw={600} size="sm">
            {t('임베딩 품질 측정')}
          </Text>
          <Text size="xs" c="dimmed">
            {t('연관 생각·군집·검색·Dream이 실제로 의미를 재고 있는지 라벨링된 문장쌍으로 확인합니다.')}
          </Text>
        </div>
        <Button
          size="xs"
          variant="light"
          leftSection={<IconRefresh size={14} />}
          loading={busy}
          onClick={() => void measure(true)}
        >
          {t('다시 측정')}
        </Button>
      </Group>

      {failed && (
        <Alert color="red" variant="light">
          {t('임베딩 백엔드를 측정하지 못했습니다. 게이트웨이 주소와 모델 이름을 확인하세요.')}
        </Alert>
      )}

      {report && (
        <Stack gap="xs">
          {report.fellBack ? (
            <Alert color="red" variant="light" title={t('설정한 모델이 쓰이지 않고 있습니다')}>
              {t(
                '모델이 설정되어 있지만 벡터는 내장 로컬 알고리즘에서 나왔습니다. 게이트웨이가 응답하지 않거나 모델 이름이 잘못되었을 수 있습니다.',
              )}
            </Alert>
          ) : report.semantic ? (
            <Alert color="teal" variant="light" title={t('의미 기반으로 동작합니다')}>
              {t('이 백엔드는 표현이 달라도 같은 뜻을 알아봅니다.')}
            </Alert>
          ) : (
            <Alert color="yellow" variant="light" title={t('지금은 어휘가 겹치는 정도만 재고 있습니다')}>
              <Text size="sm">
                {t(
                  '내장 로컬 임베딩은 단어가 겹치는 문장을 뜻이 같은 문장보다 높게 봅니다. 연관 생각·군집·검색의 "의미상 유사"는 실제로는 어휘 유사입니다. 임베딩 모델을 설정하면 해결됩니다.',
                )}
              </Text>
              {/* Saying what is wrong without saying how to fix it leaves the
                  person who most needs this — someone self-hosting who does not
                  know the compose profile exists — exactly where they were. */}
              <Text size="xs" c="dimmed" mt="xs">
                {t(
                  'umm을 docker compose로 실행 중이라면, 모델을 곁에 띄우는 것이 두 줄입니다. 받아 둔 뒤에는 네트워크 없이 동작합니다.',
                )}
              </Text>
              <Code block mt={6} fz="xs">
                {'docker compose --profile embeddings up -d\ndocker compose exec embeddings ollama pull bge-m3'}
              </Code>
              <Text size="xs" c="dimmed" mt={6}>
                {t(
                  '그 다음 아래 임베딩 Gateway 주소에 http://embeddings:11434 을, 임베딩 모델에 bge-m3 을 넣고 저장한 뒤 다시 측정하세요. 채팅 모델 주소는 그대로 두면 됩니다. 후보 모델 비교는 docs/admin-guide.md에 있습니다.',
                )}
              </Text>
            </Alert>
          )}

          <Group gap="lg">
            <div>
              <Text size="xs" c="dimmed">
                {t('판별력')}
              </Text>
              <Text fw={600} c={report.discrimination > 0 ? 'teal' : 'red'}>
                {report.discrimination > 0 ? '+' : ''}
                {report.discrimination.toFixed(3)}
              </Text>
            </div>
            <div>
              <Text size="xs" c="dimmed">
                {t('쌍별 정확도')}
              </Text>
              <Text fw={600} c={report.pairwiseAccuracy >= 0.65 ? 'teal' : 'red'}>
                {(report.pairwiseAccuracy * 100).toFixed(1)}%
              </Text>
            </div>
            <div>
              <Text size="xs" c="dimmed">
                {t('최근접 동일 주제')}
              </Text>
              <Text fw={600} c={report.neighbourPurity >= 0.6 ? 'teal' : 'red'}>
                {(report.neighbourPurity * 100).toFixed(1)}%
              </Text>
            </div>
            <div>
              <Text size="xs" c="dimmed">
                {t('측정된 백엔드')}
              </Text>
              <Code>{report.model || report.algorithm}</Code>
            </div>
          </Group>

          <Table withTableBorder striped verticalSpacing="xs" fz="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('문장쌍 종류')}</Table.Th>
                <Table.Th ta="right">{t('평균 유사도')}</Table.Th>
                <Table.Th ta="right">{t('개수')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {report.classes.map((row) => (
                <Table.Tr key={row.class}>
                  <Table.Td>{classLabels[row.class] || row.class}</Table.Td>
                  <Table.Td ta="right">{row.mean.toFixed(3)}</Table.Td>
                  <Table.Td ta="right">{row.count}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>

          <Text size="xs" c="dimmed">
            {t(
              '판별력은 "같은 뜻, 다른 표현"의 평균에서 "단어만 겹침"의 평균을 뺀 값입니다. 음수라면 뜻보다 어휘를 높게 보고 있다는 뜻입니다. 최근접 동일 주제는 라벨된 4개 주제 문장들에서 각 문장의 가장 가까운 이웃이 같은 주제인 비율로, 연관 생각과 군집이 실제로 하는 일에 가장 가깝습니다.',
            )}
          </Text>
        </Stack>
      )}
    </Card>
  );
}

function AIEvals({
  cases,
  dreamTypes,
  reload,
  notify,
}: {
  cases: EvalCase[];
  dreamTypes: string[];
  reload: () => Promise<void>;
  notify: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(t('핵심 생각 연결'));
  const [dreamType, setDreamType] = useState('connection');
  const [inputs, setInputs] = useState(t('고객 인터뷰를 매주 정리한다.\\n반복되는 불편을 제품 실험으로 바꾼다.'));
  const [expected, setExpected] = useState<string[]>([]);
  const [forbidden, setForbidden] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  const create = async () => {
    const inputNotes = inputs
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean);
    setBusy('create');
    try {
      await api(
        '/admin/ai-evals',
        json('POST', { name, dreamType, inputNotes, expectedTerms: expected, forbiddenTerms: forbidden, active: true }),
      );
      notify(t('AI 평가 케이스를 만들었습니다.'));
      await reload();
    } finally {
      setBusy('');
    }
  };
  const run = async (id: string) => {
    setBusy(id);
    try {
      const result = await api<{ status: string; result: { score: number } }>(`/admin/ai-evals/${id}/run`, {
        method: 'POST',
      });
      notify(
        t('AI 평가를 실행했습니다: {status} · {score}점', {
          status: result.status,
          score: Math.round(result.result.score * 100),
        }),
      );
      await reload();
    } finally {
      setBusy('');
    }
  };
  const remove = async (id: string) => {
    if (!window.confirm(t('이 평가 케이스와 실행 기록을 삭제할까요?'))) return;
    await api(`/admin/ai-evals/${id}`, { method: 'DELETE' });
    await reload();
  };
  return (
    <Stack gap="xl">
      <Card radius="lg" p="xl" withBorder>
        <Group align="flex-start">
          <IconFlask color="#765c96" />
          <div>
            <Title order={2} fz="xl">
              {t('회귀 평가 케이스')}
            </Title>
            <Text c="dimmed" mt={4}>
              {t('고정 입력과 기대·금지 표현으로 모델 및 프롬프트 변경 전후를 같은 기준에서 검증합니다.')}
            </Text>
          </div>
        </Group>
        <SimpleGrid cols={{ base: 1, sm: 2 }} mt="xl">
          <TextInput label={t('케이스 이름')} value={name} onChange={(event) => setName(event.currentTarget.value)} />
          <Select
            label={t('Dream 유형')}
            value={dreamType}
            data={dreamTypes}
            onChange={(value) => value && setDreamType(value)}
          />
        </SimpleGrid>
        <Textarea
          mt="lg"
          label={t('입력 생각')}
          description={t('한 줄에 하나씩, 최소 2개')}
          autosize
          minRows={4}
          maxRows={12}
          value={inputs}
          onChange={(event) => setInputs(event.currentTarget.value)}
        />
        <SimpleGrid cols={{ base: 1, sm: 2 }} mt="lg">
          <TagsInput label={t('반드시 포함할 표현')} value={expected} onChange={setExpected} splitChars={[',']} />
          <TagsInput label={t('나오면 안 되는 표현')} value={forbidden} onChange={setForbidden} splitChars={[',']} />
        </SimpleGrid>
        <Group justify="flex-end" mt="lg">
          <Button
            loading={busy === 'create'}
            disabled={!name.trim() || inputs.split('\n').filter((value) => value.trim()).length < 2}
            onClick={() => void create()}
          >
            {t('평가 케이스 만들기')}
          </Button>
        </Group>
      </Card>
      {cases.length === 0 ? (
        <Alert color="blue">{t('아직 평가 케이스가 없습니다. 대표 사용 사례부터 하나 만들어 보세요.')}</Alert>
      ) : (
        <SimpleGrid cols={{ base: 1, lg: 2 }}>
          {cases.map((item) => (
            <Card key={item.id} withBorder radius="lg" p="lg">
              <Group justify="space-between" align="flex-start">
                <div>
                  <Group gap="xs">
                    <Badge color="grape" variant="light">
                      {item.dreamType}
                    </Badge>
                    {item.latestRun && (
                      <Badge
                        color={
                          item.latestRun.status === 'passed'
                            ? 'green'
                            : item.latestRun.status === 'error'
                              ? 'red'
                              : 'yellow'
                        }
                        variant="light"
                      >
                        {t('{status} · {score}점', {
                          status: item.latestRun.status,
                          score: Math.round(item.latestRun.score * 100),
                        })}
                      </Badge>
                    )}
                  </Group>
                  <Text fw={700} mt="sm">
                    {item.name}
                  </Text>
                  <Text size="xs" c="dimmed" mt={4}>
                    {t('{inputs}개 입력 · 기대 {expected} · 금지 {forbidden}', {
                      inputs: item.inputNotes.length,
                      expected: item.expectedTerms.length,
                      forbidden: item.forbiddenTerms.length,
                    })}
                  </Text>
                </div>
                <ActionIcon
                  color="red"
                  variant="subtle"
                  aria-label={t('{name} 삭제', { name: item.name })}
                  onClick={() => void remove(item.id)}
                >
                  <IconTrash size={16} />
                </ActionIcon>
              </Group>
              {item.latestRun?.content && (
                <Paper mt="md" p="md" radius="md" bg="gray.0">
                  <Text size="sm" lineClamp={4}>
                    {item.latestRun.content}
                  </Text>
                  <Text size="xs" c="dimmed" mt="xs">
                    {item.latestRun.model} · {item.latestRun.promptVersion} · {item.latestRun.latencyMs}ms
                  </Text>
                </Paper>
              )}
              <Button
                fullWidth
                mt="lg"
                leftSection={<IconPlayerPlay size={16} />}
                loading={busy === item.id}
                onClick={() => void run(item.id)}
              >
                {t('현재 모델로 실행')}
              </Button>
            </Card>
          ))}
        </SimpleGrid>
      )}
    </Stack>
  );
}
const IconMoon = IconBrain;
function Metric({ label, value, progress }: { label: string; value: string; progress?: number }) {
  return (
    <div>
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Text fz="xl" fw={680} mt={4}>
        {value}
      </Text>
      {progress !== undefined && <Progress value={progress} color="grape" mt="sm" />}
    </div>
  );
}

function Users({
  users,
  update,
}: {
  users: AdminUser[];
  update: (u: AdminUser, p: Partial<AdminUser>) => Promise<void>;
}) {
  const { t } = useTranslation();
  return (
    <Card radius="lg" withBorder p="xl">
      <Text c="dimmed" mb="lg">
        {t('Keycloak 그룹 매핑 또는 여기에서 역할과 팀을 변경할 수 있습니다.')}
      </Text>
      <Table.ScrollContainer minWidth={780}>
        <Table verticalSpacing="md" highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('사용자')}</Table.Th>
              <Table.Th>{t('역할')}</Table.Th>
              <Table.Th>{t('팀')}</Table.Th>
              <Table.Th>{t('상태')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {users.map((u) => (
              <Table.Tr key={u.id}>
                <Table.Td>
                  <Text fw={600}>{u.displayName}</Text>
                  <Text size="xs" c="dimmed">
                    {u.username} · {u.email}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Select
                    w={140}
                    value={u.role}
                    data={[
                      { value: 'user', label: t('사용자') },
                      { value: 'team_lead', label: t('팀장') },
                      { value: 'admin', label: t('관리자') },
                    ]}
                    onChange={(v) => v && void update(u, { role: v })}
                  />
                </Table.Td>
                <Table.Td>
                  <TextInput
                    w={160}
                    defaultValue={u.teamName}
                    placeholder={t('팀 없음')}
                    onBlur={(e) => void update(u, { teamName: e.currentTarget.value })}
                  />
                </Table.Td>
                <Table.Td>
                  <Switch checked={u.active} onChange={(e) => void update(u, { active: e.currentTarget.checked })} />
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Card>
  );
}
function AuditTable({
  entries,
  nextCursor,
  loading,
  onMore,
  actions,
  filter,
  onFilter,
  onSearch,
}: {
  entries: Audit[];
  nextCursor: string;
  loading: boolean;
  onMore: () => Promise<void>;
  /* The actions actually in the log, so nobody has to type space.unshare. */
  actions: string[];
  filter: { actor: string; action: string; resourceId: string };
  onFilter: (next: { actor: string; action: string; resourceId: string }) => void;
  onSearch: (using?: { actor: string; action: string; resourceId: string }) => Promise<void>;
}) {
  const { t, formatDate } = useTranslation();
  const filtering = !!(filter.actor.trim() || filter.action || filter.resourceId.trim());
  return (
    <Card radius="lg" withBorder p="xl">
      <Group align="flex-end" gap="sm" mb="lg" wrap="wrap">
        <TextInput
          label={t('행위자')}
          placeholder={t('아이디 또는 system')}
          value={filter.actor}
          onChange={(e) => onFilter({ ...filter, actor: e.currentTarget.value })}
          w={200}
        />
        <Select
          label={t('작업')}
          placeholder={t('전체')}
          data={actions}
          value={filter.action || null}
          onChange={(v) => onFilter({ ...filter, action: v || '' })}
          clearable
          searchable
          w={220}
        />
        <TextInput
          label={t('대상 ID')}
          placeholder={t('공간·메모·키의 ID')}
          value={filter.resourceId}
          onChange={(e) => onFilter({ ...filter, resourceId: e.currentTarget.value })}
          w={300}
        />
        <Button loading={loading} onClick={() => void onSearch()}>
          {t('찾기')}
        </Button>
        {filtering && (
          <Button
            variant="subtle"
            color="gray"
            onClick={() => {
              const cleared = { actor: '', action: '', resourceId: '' };
              onFilter(cleared);
              // Handed over rather than read back: the state set on the line
              // above is not visible to onSearch yet.
              void onSearch(cleared);
            }}
          >
            {t('조건 지우기')}
          </Button>
        )}
      </Group>
      {filtering && entries.length === 0 && !loading && (
        <Text c="dimmed" mb="md">
          {t('이 조건에 맞는 기록이 없습니다. 기록이 없다는 뜻이지, 찾지 못했다는 뜻이 아닙니다.')}
        </Text>
      )}
      <Table.ScrollContainer minWidth={760}>
        <Table verticalSpacing="sm" striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('시각')}</Table.Th>
              <Table.Th>{t('행위자')}</Table.Th>
              <Table.Th>{t('작업')}</Table.Th>
              <Table.Th>{t('대상')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {entries.map((e) => (
              <Table.Tr key={e.id}>
                <Table.Td>
                  <Text size="sm">{formatDate(e.createdAt)}</Text>
                </Table.Td>
                <Table.Td>{e.actor}</Table.Td>
                <Table.Td>
                  <Badge variant="light" color="gray">
                    {e.action}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  {e.resourceType} ·{' '}
                  <Text span c="dimmed" size="xs">
                    {e.resourceId}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {nextCursor && (
        <Group justify="center" mt="lg">
          <Button variant="light" loading={loading} onClick={() => void onMore()}>
            {t('이전 로그 더 불러오기')}
          </Button>
        </Group>
      )}
    </Card>
  );
}
