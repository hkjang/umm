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
  IconChartBar,
  IconCheck,
  IconFlask,
  IconKey,
  IconMail,
  IconPlayerPlay,
  IconPlugConnected,
  IconRefresh,
  IconSearch,
  IconPresentation,
  IconRobot,
  IconRoute,
  IconSend,
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
  ['analytics', msg('방문 추적'), IconChartBar],
  ['handoff', msg('다른 서비스로 보내기'), IconSend],
  ['mail', msg('메일 알림'), IconMail],
  ['intelligence', msg('유사도 기준'), IconAdjustments],
  ['ai_evals', msg('AI 품질 평가'), IconFlask],
  ['security', msg('키 · 권한'), IconShield],
  ['workflow', msg('검토 프로세스'), IconRoute],
  ['users', msg('사용자'), IconUsers],
  ['spaces', msg('공간과 참여자'), IconUsers],
  ['webhooks', msg('웹훅 상태'), IconRoute],
  ['audit', msg('감사 로그'), IconAdjustments],
] as const;
interface AdminSpace {
  id: string;
  name: string;
  isInbox: boolean;
  owner: string;
  ownerId: string;
  ownerActive: boolean;
  members: number;
  notes: number;
}
interface BandOutcome {
  relatedBand: number;
  clusterBand: number;
  withoutRelated: number;
  medianRelated: number;
  mostRelated: number;
  clusters: number;
  grouped: number;
  largestCluster: number;
  ungrouped: number;
}
interface BandPreview {
  spaces: number;
  notes: number;
  embedded: number;
  semantic: boolean;
  current: BandOutcome;
  proposed: BandOutcome;
}
interface AdminWebhook {
  id: string;
  name: string;
  destination: string;
  active: boolean;
  failureCount: number;
  lastError: string;
  lastDeliveredAt?: string;
  owner: string;
  ownerActive: boolean;
  failed24h: number;
  waiting: number;
}
interface SpaceMember {
  id: string;
  username: string;
  active: boolean;
  permission: string;
}
interface MailDelivery {
  id: string;
  event: string;
  recipient: string;
  subject: string;
  status: string;
  attempts: number;
  errorMessage?: string;
  createdAt: string;
}
interface MailDeliveryPage {
  deliveries: MailDelivery[];
  total: number;
  byStatus: Record<string, number>;
}
interface PolicyViolation {
  origin: string;
  directive: string;
  page: string;
  count: number;
  lastSeen: string;
  allowed: boolean;
}
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
  const [spaces, setSpaces] = useState<AdminSpace[]>([]);
  const [spacesOrphanOnly, setSpacesOrphanOnly] = useState(false);
  const [spacesLoading, setSpacesLoading] = useState(false);
  const [spaceMembers, setSpaceMembers] = useState<Record<string, SpaceMember[]>>({});
  const [adminWebhooks, setAdminWebhooks] = useState<AdminWebhook[]>([]);
  const [webhooksFailingOnly, setWebhooksFailingOnly] = useState(false);
  const [adminWebhooksLoading, setAdminWebhooksLoading] = useState(false);
  const [bandPreview, setBandPreview] = useState<BandPreview | null>(null);
  const [bandPreviewLoading, setBandPreviewLoading] = useState(false);
  const [bandPreviewError, setBandPreviewError] = useState('');
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
    // Fetched when the section is opened rather than with everything else: a
    // list of every space is not worth loading for someone who came to change
    // a setting.
    if (section === 'spaces' && spaces.length === 0) void loadSpaces();
    if (section === 'webhooks' && adminWebhooks.length === 0) void loadAdminWebhooks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // What the browser's policy refused while tracking was on. Fetched when the
  // section is opened and on demand, because the list only means anything to
  // someone looking at a snippet that is not reporting.
  const [violations, setViolations] = useState<PolicyViolation[]>([]);
  const [violationsLoading, setViolationsLoading] = useState(false);
  const loadViolations = useCallback(async () => {
    setViolationsLoading(true);
    try {
      const result = await api<{ violations: PolicyViolation[] }>('/admin/analytics/violations');
      setViolations(result.violations ?? []);
    } catch {
      setViolations([]);
    } finally {
      setViolationsLoading(false);
    }
  }, []);
  const forgetViolations = async () => {
    setBusy('violations-forget');
    try {
      await api('/admin/analytics/violations', { method: 'DELETE' });
      setViolations([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('차단 기록을 지우지 못했습니다.'));
    } finally {
      setBusy('');
    }
  };
  // One click from "this origin was refused" to "this origin is allowed". The
  // list keeps what is there, in order, and ignores an origin already present.
  const allowOrigin = (origin: string) => {
    const existing = String(settings.analytics?.allowed_hosts || '');
    const entries = existing
      .split(/[,\s]+/)
      .map((entry) => entry.trim().replace(/\/$/, ''))
      .filter(Boolean);
    const cleaned = origin.replace(/\/$/, '');
    if (entries.some((entry) => entry.toLowerCase() === cleaned.toLowerCase())) return;
    update('analytics', 'allowed_hosts', [...entries, cleaned].join(', '));
  };
  useEffect(() => {
    if (section === 'analytics') void loadViolations();
  }, [section, loadViolations]);

  // What left the building. Fetched when the section is opened and after a
  // test send, because "did it go out?" is the question this screen answers.
  const [mailDeliveries, setMailDeliveries] = useState<MailDeliveryPage | null>(null);
  const [mailDeliveriesLoading, setMailDeliveriesLoading] = useState(false);
  const [mailTestRecipient, setMailTestRecipient] = useState('');
  const loadMailDeliveries = useCallback(async () => {
    setMailDeliveriesLoading(true);
    try {
      setMailDeliveries(await api<MailDeliveryPage>('/admin/mail/deliveries?limit=50'));
    } catch {
      setMailDeliveries(null);
    } finally {
      setMailDeliveriesLoading(false);
    }
  }, []);
  useEffect(() => {
    if (section === 'mail') void loadMailDeliveries();
  }, [section, loadMailDeliveries]);
  // One real mail through the saved settings — the relay's own answer, here,
  // before anybody depends on it.
  const testMail = async () => {
    setBusy('mail-test');
    setError('');
    try {
      const result = await api<{ sent: boolean; recipient: string }>(
        '/admin/mail/test',
        json('POST', { recipient: mailTestRecipient.trim() }),
      );
      setMessage(t('릴레이가 받았습니다 · {recipient} 로 보냈습니다.', { recipient: result.recipient }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('시험 발송 실패'));
    } finally {
      setBusy('');
      void loadMailDeliveries();
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
  const loadSpaces = async (orphanOnly = spacesOrphanOnly) => {
    setSpacesLoading(true);
    setError('');
    try {
      const query = new URLSearchParams({ limit: '50' });
      if (orphanOnly) query.set('ownerInactive', 'true');
      const value = await api<{ spaces: AdminSpace[] }>(`/admin/spaces?${query}`);
      setSpaces(value.spaces);
      setSpaceMembers({});
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('공간 목록을 불러오지 못했습니다.'));
    } finally {
      setSpacesLoading(false);
    }
  };
  const loadSpaceMembers = async (spaceId: string) => {
    if (spaceMembers[spaceId]) return;
    try {
      const value = await api<{ members: SpaceMember[] }>(`/admin/spaces/${spaceId}/members`);
      setSpaceMembers((all) => ({ ...all, [spaceId]: value.members }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('공간 참여자를 불러오지 못했습니다.'));
    }
  };
  const transferSpace = async (space: AdminSpace, userId: string) => {
    const target = users.find((u) => u.id === userId);
    if (!target) return;
    if (
      !window.confirm(
        t('“{space}”의 소유자를 {user}(으)로 바꿉니다. 계속할까요?', { space: space.name, user: target.username }),
      )
    )
      return;
    try {
      const result = await api<{ previousKeptAccess: boolean }>(
        `/admin/spaces/${space.id}/owner`,
        json('PUT', { userId }),
      );
      setMessage(
        result.previousKeptAccess
          ? t('소유자를 바꿨습니다. 이전 소유자는 관리 권한으로 남았습니다.')
          : t('소유자를 바꿨습니다. 이전 소유자는 비활성이라 접근 권한을 남기지 않았습니다.'),
      );
      await loadSpaces();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('공간 소유자를 바꾸지 못했습니다.'));
    }
  };
  const previewBands = async (related: unknown, cluster: unknown) => {
    setBandPreviewLoading(true);
    setBandPreviewError('');
    try {
      const query = new URLSearchParams();
      if (typeof related === 'number') query.set('related_band', String(related));
      if (typeof cluster === 'number') query.set('cluster_band', String(cluster));
      setBandPreview(await api<BandPreview>(`/admin/intelligence/preview?${query.toString()}`));
    } catch (reason) {
      // The panel says nothing rather than showing the last answer beside new
      // numbers it does not describe.
      setBandPreview(null);
      setBandPreviewError(reason instanceof Error ? reason.message : t('지금 데이터로 미리 보지 못했습니다.'));
    } finally {
      setBandPreviewLoading(false);
    }
  };
  const loadAdminWebhooks = async (failingOnly = webhooksFailingOnly) => {
    setAdminWebhooksLoading(true);
    setError('');
    try {
      const query = failingOnly ? '?failing=true' : '';
      const value = await api<{ webhooks: AdminWebhook[] }>(`/admin/webhooks${query}`);
      setAdminWebhooks(value.webhooks);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('웹훅 목록을 불러오지 못했습니다.'));
    } finally {
      setAdminWebhooksLoading(false);
    }
  };
  const pauseAdminWebhook = async (hook: AdminWebhook) => {
    if (
      !window.confirm(
        t('“{name}” 웹훅 전송을 멈춥니다. 설정은 그대로 남고 주인이 다시 켤 수 있습니다.', { name: hook.name }),
      )
    )
      return;
    try {
      await api(`/admin/webhooks/${hook.id}/pause`, { method: 'POST' });
      setMessage(t('웹훅 전송을 멈췄습니다.'));
      await loadAdminWebhooks();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('웹훅을 멈추지 못했습니다.'));
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
              <Switch
                size="md"
                label={t('이미 Keycloak에 로그인한 사람은 로그인 화면 없이 바로 들어오기')}
                description={t(
                  '켜면 브라우저가 먼저 조용히(prompt=none) Keycloak 세션을 확인하고, 세션이 있으면 바로 본 화면으로 들어갑니다. 없으면 평소처럼 로그인 화면이 뜨며, 한 탭에서 한 번만 시도합니다.',
                )}
                disabled={!settings.oidc.enabled}
                checked={!!settings.oidc.auto_login}
                onChange={(e) => update('oidc', 'auto_login', e.currentTarget.checked)}
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
          {section === 'analytics' && settings.analytics && (
            <Stack gap="lg">
              <SettingCard
                dirty={settingChanged(settings.analytics, savedSettings.analytics)}
                title={t('방문 추적')}
                description={t(
                  '어느 화면이 실제로 쓰이는지 세는 추적 스크립트를 화면에 붙입니다. 기본은 꺼짐이며, 켜기 전까지 방문에 관해 어디에도 아무것도 보내지 않습니다.',
                )}
                onSave={() => save('analytics')}
              >
                <Switch
                  size="lg"
                  label={t('방문 추적 켜기')}
                  checked={!!settings.analytics.enabled}
                  onChange={(e) => update('analytics', 'enabled', e.currentTarget.checked)}
                />
                <Select
                  label={t('추적 도구')}
                  description={t(
                    'Momento는 사내에서 직접 운영하는 수집기라 데이터가 밖으로 나가지 않는 유일한 선택지입니다.',
                  )}
                  allowDeselect={false}
                  data={[
                    { value: 'momento', label: t('Momento (사내 수집기)') },
                    { value: 'ga4', label: 'Google Analytics 4' },
                    { value: 'gtm', label: 'Google Tag Manager' },
                    { value: 'matomo', label: 'Matomo' },
                    { value: 'custom', label: t('직접 붙여 넣기') },
                  ]}
                  value={settings.analytics.provider || 'momento'}
                  onChange={(value) => update('analytics', 'provider', value || 'momento')}
                />
                {(settings.analytics.provider || 'momento') === 'momento' && (
                  <>
                    <SimpleGrid cols={{ base: 1, sm: 2 }}>
                      <TextInput
                        label={t('Momento 수집기 주소')}
                        placeholder="https://momento.internal"
                        value={settings.analytics.momento_url || ''}
                        onChange={(e) => update('analytics', 'momento_url', e.currentTarget.value)}
                      />
                      <TextInput
                        label={t('사이트 ID')}
                        placeholder="umm-prd"
                        value={settings.analytics.momento_site_id || ''}
                        onChange={(e) => update('analytics', 'momento_site_id', e.currentTarget.value)}
                      />
                    </SimpleGrid>
                    <Switch
                      label={t('같은 오리진 프록시로 보내기 (권장)')}
                      description={t(
                        '켜면 브라우저는 umm의 /momento 경로로만 이야기하고 umm이 수집기로 넘깁니다. 외부 출처가 보안 정책에 아예 등장하지 않으므로 정책을 바꿀 수 없는 설치에서도 동작합니다.',
                      )}
                      checked={settings.analytics.momento_proxy !== false}
                      onChange={(e) => update('analytics', 'momento_proxy', e.currentTarget.checked)}
                    />
                  </>
                )}
                {(settings.analytics.provider === 'ga4' || settings.analytics.provider === 'gtm') && (
                  <TextInput
                    label={settings.analytics.provider === 'ga4' ? t('측정 ID') : t('컨테이너 ID')}
                    placeholder={settings.analytics.provider === 'ga4' ? 'G-XXXXXXXXXX' : 'GTM-XXXXXXX'}
                    value={settings.analytics.measurement_id || ''}
                    onChange={(e) => update('analytics', 'measurement_id', e.currentTarget.value)}
                  />
                )}
                {settings.analytics.provider === 'matomo' && (
                  <SimpleGrid cols={{ base: 1, sm: 2 }}>
                    <TextInput
                      label={t('Matomo 주소')}
                      placeholder="https://matomo.internal"
                      value={settings.analytics.matomo_url || ''}
                      onChange={(e) => update('analytics', 'matomo_url', e.currentTarget.value)}
                    />
                    <TextInput
                      label={t('사이트 ID')}
                      placeholder="1"
                      value={settings.analytics.matomo_site_id || ''}
                      onChange={(e) => update('analytics', 'matomo_site_id', e.currentTarget.value)}
                    />
                  </SimpleGrid>
                )}
                {settings.analytics.provider === 'custom' && (
                  <Textarea
                    label={t('추적 스니펫')}
                    description={t(
                      '추적 도구가 준 <script> 코드를 그대로 붙여 넣습니다. 8KB까지이며, 요청마다 nonce가 모든 <script> 태그에 자동으로 붙고 코드 안의 http(s) 출처가 보안 정책에 더해집니다.',
                    )}
                    autosize
                    minRows={4}
                    maxRows={14}
                    styles={{ input: { fontFamily: 'monospace', fontSize: 12 } }}
                    value={settings.analytics.custom_snippet || ''}
                    onChange={(e) => update('analytics', 'custom_snippet', e.currentTarget.value)}
                  />
                )}
                <TextInput
                  label={t('추가로 허용할 출처')}
                  description={t(
                    '스니펫에서 자동으로 읽지 못한 출처를 https://host 형태로, 쉼표로 구분해 적습니다. 아래 차단 목록에서 한 번 눌러 더할 수도 있습니다.',
                  )}
                  placeholder="https://cdn.example, https://collect.example"
                  value={settings.analytics.allowed_hosts || ''}
                  onChange={(e) => update('analytics', 'allowed_hosts', e.currentTarget.value)}
                />
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <Select
                    label={t('넣는 자리')}
                    allowDeselect={false}
                    data={[
                      { value: 'head', label: '<head>' },
                      { value: 'body', label: '<body>' },
                    ]}
                    value={settings.analytics.placement === 'body' ? 'body' : 'head'}
                    onChange={(value) => update('analytics', 'placement', value || 'head')}
                  />
                  <Switch
                    mt={{ sm: 28 }}
                    label={t('관리 화면에서도 추적')}
                    description={t('기본은 아니오 — 관리자의 화면은 대개 세고 싶은 방문이 아닙니다.')}
                    checked={!!settings.analytics.include_admin}
                    onChange={(e) => update('analytics', 'include_admin', e.currentTarget.checked)}
                  />
                </SimpleGrid>
                <Alert color="blue">
                  {t(
                    "이 앱의 보안 정책(CSP)은 script-src를 응답마다 다른 nonce로 잠급니다. 'unsafe-inline'으로 풀지 않고, 스니펫의 모든 <script>에 그 nonce를 붙이고 스니펫이 쓰는 출처만 그 화면의 정책에 더합니다. 끄면 정책은 원래대로 좁아집니다.",
                  )}
                </Alert>
              </SettingCard>
              <Card className="admin-setting-card" radius="lg" p={{ base: 'lg', sm: 'xl' }} withBorder>
                <Group justify="space-between" align="flex-start">
                  <div>
                    <Title order={2} fz="xl">
                      {t('정책이 차단한 출처')}
                    </Title>
                    <Text c="dimmed" mt={5}>
                      {t(
                        '추적이 켜져 있는 동안 브라우저가 보안 정책 때문에 거절한 주소입니다. 같은 출처는 한 줄로 모이고, 최근 100개까지 이 서버의 메모리에만 남습니다. 화면이 비어 있는데 수집이 안 된다면 여기부터 보세요.',
                      )}
                    </Text>
                  </div>
                  <Group gap="xs">
                    <Button
                      size="xs"
                      variant="light"
                      leftSection={<IconRefresh size={14} />}
                      loading={violationsLoading}
                      onClick={() => void loadViolations()}
                    >
                      {t('새로 고침')}
                    </Button>
                    <Button
                      size="xs"
                      variant="subtle"
                      color="gray"
                      leftSection={<IconTrash size={14} />}
                      loading={busy === 'violations-forget'}
                      disabled={violations.length === 0}
                      onClick={() => void forgetViolations()}
                    >
                      {t('기록 비우기')}
                    </Button>
                  </Group>
                </Group>
                {violations.length === 0 ? (
                  <Text c="dimmed" mt="md">
                    {settings.analytics.enabled
                      ? t('차단된 출처가 없습니다.')
                      : t('추적이 꺼져 있는 동안에는 기록하지 않습니다.')}
                  </Text>
                ) : (
                  <Table mt="md" verticalSpacing="xs">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>{t('출처')}</Table.Th>
                        <Table.Th>{t('지시어')}</Table.Th>
                        <Table.Th>{t('화면')}</Table.Th>
                        <Table.Th ta="right">{t('횟수')}</Table.Th>
                        <Table.Th />
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {violations.map((violation) => (
                        <Table.Tr key={`${violation.directive} ${violation.origin}`}>
                          <Table.Td>
                            <Code>{violation.origin}</Code>
                          </Table.Td>
                          <Table.Td>
                            <Code>{violation.directive}</Code>
                          </Table.Td>
                          <Table.Td>{violation.page}</Table.Td>
                          <Table.Td ta="right">{violation.count}</Table.Td>
                          <Table.Td ta="right">
                            {violation.allowed ? (
                              <Badge color="teal" variant="light">
                                {t('허용됨')}
                              </Badge>
                            ) : (
                              <Button size="compact-xs" variant="light" onClick={() => allowOrigin(violation.origin)}>
                                {t('허용 목록에 더하기')}
                              </Button>
                            )}
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                )}
                {violations.some((violation) => !violation.allowed) && (
                  <Text c="dimmed" fz="sm" mt="sm">
                    {t(
                      '더한 출처는 위 카드를 저장해야 정책에 들어갑니다. 저장 뒤 화면을 새로 열면 그 출처는 더 이상 차단되지 않습니다.',
                    )}
                  </Text>
                )}
              </Card>
            </Stack>
          )}
          {section === 'handoff' && settings.handoff && (
            <HandoffSettings
              dirty={settingChanged(settings.handoff, savedSettings.handoff)}
              targets={Array.isArray(settings.handoff.targets) ? settings.handoff.targets : []}
              update={(targets) => update('handoff', 'targets', targets)}
              save={() => save('handoff')}
            />
          )}
          {section === 'mail' && settings.mail && (
            <Stack gap="lg">
              <SettingCard
                dirty={settingChanged(settings.mail, savedSettings.mail)}
                title={t('메일 알림')}
                description={t(
                  '사내 SMTP 릴레이로 알림을 보냅니다. 기본은 꺼짐이며, 켜기 전까지 아무에게도 아무것도 보내지 않습니다. 사내 릴레이는 대개 포트 25 · 인증 없음 · TLS 없음이므로 그것이 기본값이고, 인증과 암호화는 있을 때만 씁니다.',
                )}
                onSave={() => save('mail')}
              >
                <Switch
                  size="lg"
                  label={t('메일 알림 켜기')}
                  description={t(
                    '켜려면 릴레이 주소가 있어야 합니다. 먼저 저장하고 시험 발송으로 릴레이를 확인한 뒤 켜는 순서를 권합니다.',
                  )}
                  checked={!!settings.mail.enabled}
                  onChange={(e) => update('mail', 'enabled', e.currentTarget.checked)}
                />
                <SimpleGrid cols={{ base: 1, sm: 3 }}>
                  <TextInput
                    label={t('SMTP 릴레이 주소')}
                    description={t('호스트 이름이나 IP 만. 포트는 옆에.')}
                    placeholder="relay.intra"
                    value={settings.mail.smtp_host || ''}
                    onChange={(e) => update('mail', 'smtp_host', e.currentTarget.value)}
                  />
                  <NumberInput
                    label={t('포트')}
                    min={1}
                    max={65535}
                    value={settings.mail.smtp_port ?? 25}
                    onChange={(v) => update('mail', 'smtp_port', v)}
                  />
                  <Select
                    label={t('보안')}
                    description={t('auto 는 릴레이가 STARTTLS 를 알리면 쓰고 아니면 평문으로 보냅니다.')}
                    allowDeselect={false}
                    data={[
                      { value: 'auto', label: t('auto (릴레이가 알리는 대로)') },
                      { value: 'none', label: t('none (평문)') },
                      { value: 'starttls', label: 'STARTTLS' },
                      { value: 'tls', label: t('tls (처음부터 TLS, 보통 465)') },
                    ]}
                    value={settings.mail.security || 'auto'}
                    onChange={(value) => update('mail', 'security', value || 'auto')}
                  />
                </SimpleGrid>
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <TextInput
                    label={t('사용자 이름 (선택)')}
                    description={t('인증 없는 릴레이면 비워 둡니다.')}
                    value={settings.mail.username || ''}
                    onChange={(e) => update('mail', 'username', e.currentTarget.value)}
                  />
                  <PasswordInput
                    label={t('비밀번호 (선택)')}
                    description={
                      settings.mail.password_configured
                        ? t('설정됨. 저장된 값은 화면에 돌아오지 않습니다 — 바꿀 때만 새 값을 적습니다.')
                        : t('저장하면 암호화되어 보관되고 화면에 돌아오지 않습니다.')
                    }
                    placeholder={settings.mail.password_configured ? t('설정됨') : ''}
                    value={settings.mail.password || ''}
                    onChange={(e) => update('mail', 'password', e.currentTarget.value)}
                  />
                </SimpleGrid>
                <Switch
                  label={t('릴레이 인증서 검증 건너뛰기')}
                  description={t('사내 사설 인증서일 때만. STARTTLS · tls 에서만 뜻이 있습니다.')}
                  checked={!!settings.mail.skip_tls_verify}
                  onChange={(e) => update('mail', 'skip_tls_verify', e.currentTarget.checked)}
                />
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <TextInput
                    label={t('보내는 사람 주소')}
                    description={t(
                      '비우면 umm@<릴레이 주소> 를 씁니다. 릴레이가 발신 도메인을 검사하면 실제 주소를 적습니다.',
                    )}
                    placeholder="umm@company.example"
                    value={settings.mail.from_address || ''}
                    onChange={(e) => update('mail', 'from_address', e.currentTarget.value)}
                  />
                  <TextInput
                    label={t('보내는 사람 이름')}
                    placeholder="umm"
                    value={settings.mail.from_name || ''}
                    onChange={(e) => update('mail', 'from_name', e.currentTarget.value)}
                  />
                </SimpleGrid>
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <TextInput
                    label={t('메일 속 링크 주소')}
                    description={t('비우면 일반 → 공개 URL 을 씁니다.')}
                    placeholder="https://umm.intra"
                    value={settings.mail.base_url || ''}
                    onChange={(e) => update('mail', 'base_url', e.currentTarget.value)}
                  />
                  <NumberInput
                    label={t('제한 시간')}
                    suffix={t(' 초')}
                    min={1}
                    max={120}
                    value={settings.mail.timeout_seconds ?? 10}
                    onChange={(v) => update('mail', 'timeout_seconds', v)}
                  />
                </SimpleGrid>
                <Divider label={t('어떤 일을 알릴지')} labelPosition="left" />
                <Text c="dimmed" fz="sm">
                  {t(
                    '이 메일이 오지 않으면 누군가 기다리게 되는 다섯 가지입니다. 자기가 한 일은 자기에게 보내지 않고, 한 번의 작업은 한 사람에게 한 통입니다.',
                  )}
                </Text>
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  {(
                    [
                      ['notify_approval_request', t('검토 요청이 도착함 → 검토할 수 있는 팀장·관리자')],
                      ['notify_approval_decision', t('내 요청이 승인·반려됨 → 요청한 사람')],
                      ['notify_space_shared', t('공간이 나에게 공유됨 → 공유받은 사람')],
                      ['notify_mention', t('댓글에서 나를 언급함 → 언급된 사람')],
                      ['notify_comment', t('내 생각에 댓글이 달림 → 생각의 작성자')],
                    ] as const
                  ).map(([key, label]) => (
                    <Checkbox
                      key={key}
                      label={label}
                      checked={settings.mail[key] !== false}
                      onChange={(e) => update('mail', key, e.currentTarget.checked)}
                    />
                  ))}
                </SimpleGrid>
              </SettingCard>
              <Card className="admin-setting-card" radius="lg" p={{ base: 'lg', sm: 'xl' }} withBorder>
                <Title order={3} fz="lg">
                  {t('시험 발송')}
                </Title>
                <Text c="dimmed" mt={5}>
                  {t(
                    '저장한 설정으로 실제 한 통을 보내고 릴레이의 답을 그 자리에서 보여 줍니다. 릴레이 설정은 한 번에 맞는 일이 드뭅니다. 알림을 켜지 않아도 보낼 수 있습니다.',
                  )}
                </Text>
                <Group mt="md" align="flex-end">
                  <TextInput
                    style={{ flex: 1 }}
                    label={t('받는 사람')}
                    description={t('비우면 내 계정의 메일 주소로 보냅니다.')}
                    placeholder="me@company.example"
                    value={mailTestRecipient}
                    onChange={(e) => setMailTestRecipient(e.currentTarget.value)}
                  />
                  <Button
                    leftSection={<IconSend size={14} />}
                    loading={busy === 'mail-test'}
                    disabled={settingChanged(settings.mail, savedSettings.mail)}
                    onClick={() => void testMail()}
                  >
                    {t('시험 발송')}
                  </Button>
                </Group>
                {settingChanged(settings.mail, savedSettings.mail) && (
                  <Text c="yellow.8" fz="sm" mt="sm">
                    {t('저장하지 않은 변경이 있습니다. 시험 발송은 저장된 설정으로 나갑니다 — 먼저 저장하세요.')}
                  </Text>
                )}
              </Card>
              <Card className="admin-setting-card" radius="lg" p={{ base: 'lg', sm: 'xl' }} withBorder>
                <Group justify="space-between" align="flex-start">
                  <div>
                    <Title order={3} fz="lg">
                      {t('발송 기록')}
                    </Title>
                    <Text c="dimmed" mt={5}>
                      {t(
                        '무엇이 건물 밖으로 나갔는지. 시도마다 한 줄 — 성공과 실패 모두 — 이고 본문은 담지 않습니다. 90일 동안 보관합니다.',
                      )}
                    </Text>
                  </div>
                  <Group gap="xs">
                    {mailDeliveries && (
                      <Text c="dimmed" fz="sm">
                        {t('전체 {total} · 성공 {sent} · 실패 {failed}', {
                          total: mailDeliveries.total,
                          sent: mailDeliveries.byStatus.sent ?? 0,
                          failed: mailDeliveries.byStatus.failed ?? 0,
                        })}
                      </Text>
                    )}
                    <Button
                      size="xs"
                      variant="light"
                      leftSection={<IconRefresh size={14} />}
                      loading={mailDeliveriesLoading}
                      onClick={() => void loadMailDeliveries()}
                    >
                      {t('새로고침')}
                    </Button>
                  </Group>
                </Group>
                {!mailDeliveries || mailDeliveries.deliveries.length === 0 ? (
                  <Text c="dimmed" mt="md">
                    {t('아직 보낸 메일이 없습니다.')}
                  </Text>
                ) : (
                  <Table mt="md" verticalSpacing="xs">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>{t('시각')}</Table.Th>
                        <Table.Th>{t('이벤트')}</Table.Th>
                        <Table.Th>{t('받는 사람')}</Table.Th>
                        <Table.Th>{t('제목')}</Table.Th>
                        <Table.Th>{t('결과')}</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {mailDeliveries.deliveries.map((delivery) => (
                        <Table.Tr key={delivery.id}>
                          <Table.Td>{new Date(delivery.createdAt).toLocaleString()}</Table.Td>
                          <Table.Td>
                            <Code>{delivery.event}</Code>
                          </Table.Td>
                          <Table.Td>{delivery.recipient}</Table.Td>
                          <Table.Td>{delivery.subject}</Table.Td>
                          <Table.Td>
                            {delivery.status === 'sent' ? (
                              <Badge color="teal" variant="light">
                                {t('성공')}
                              </Badge>
                            ) : delivery.status === 'failed' ? (
                              <Tooltip
                                label={delivery.errorMessage || ''}
                                multiline
                                w={360}
                                disabled={!delivery.errorMessage}
                              >
                                <Badge color="red" variant="light">
                                  {t('실패 · {attempts}회', { attempts: delivery.attempts })}
                                </Badge>
                              </Tooltip>
                            ) : (
                              <Badge color="gray" variant="light">
                                {t('보내는 중')}
                              </Badge>
                            )}
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                )}
              </Card>
            </Stack>
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
                  label={t('채팅 Timeout')}
                  description={t('긴 추론 모델은 충분한 시간을 지정하세요.')}
                  suffix={t(' 초')}
                  min={5}
                  max={1800}
                  value={settings.ai_gateway.timeout_seconds}
                  onChange={(v) => update('ai_gateway', 'timeout_seconds', v)}
                />
                {/* Its own number, because the two wait for different things.
                    A chat model composing a Dream is given minutes; embedding a
                    sentence is a millisecond of work behind a network hop, and
                    whoever is waiting on it is searching. */}
                <NumberInput
                  label={t('임베딩 Timeout')}
                  description={t('검색이 기다리는 시간입니다. 짧게 두세요 — 넘으면 로컬로 계산합니다.')}
                  suffix={t(' 초')}
                  min={1}
                  max={120}
                  value={settings.ai_gateway.embedding_timeout_seconds}
                  onChange={(v) => update('ai_gateway', 'embedding_timeout_seconds', v)}
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

              <BandPreviewCard
                preview={bandPreview}
                loading={bandPreviewLoading}
                error={bandPreviewError}
                onPreview={() =>
                  void previewBands(settings.intelligence?.related_band, settings.intelligence?.cluster_band)
                }
              />

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
          {section === 'spaces' && (
            <SpacesPanel
              spaces={spaces}
              loading={spacesLoading}
              orphanOnly={spacesOrphanOnly}
              members={spaceMembers}
              users={users}
              onOrphanOnly={(next) => {
                setSpacesOrphanOnly(next);
                void loadSpaces(next);
              }}
              onReload={() => void loadSpaces()}
              onExpand={loadSpaceMembers}
              onTransfer={transferSpace}
            />
          )}
          {section === 'webhooks' && (
            <WebhookHealthPanel
              webhooks={adminWebhooks}
              loading={adminWebhooksLoading}
              failingOnly={webhooksFailingOnly}
              onFailingOnly={(next) => {
                setWebhooksFailingOnly(next);
                void loadAdminWebhooks(next);
              }}
              onReload={() => void loadAdminWebhooks()}
              onPause={pauseAdminWebhook}
            />
          )}
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

/**
 * Where a space may be sent.
 *
 * The other half of the in-house handoff standard: umm issues a claim and
 * opens the receiving service with it, so nobody downloads a file and no
 * service holds a credential for another. The list is what the canvas offers
 * under "다른 서비스로 보내기" — empty by default, and then the menu does not
 * exist. A target is shown only when it receives what umm sends (Markdown),
 * so "받는 형식" is what decides whether a named service is actually offered.
 */
interface HandoffTargetDraft {
  name: string;
  origin: string;
  formats: string[];
}
const handoffFormats = ['markdown', 'docx', 'csv', 'xlsx', 'txt', 'pptx'];
function HandoffSettings({
  targets,
  update,
  save,
  dirty,
}: {
  targets: HandoffTargetDraft[];
  update: (targets: HandoffTargetDraft[]) => void;
  save: () => void;
  dirty: boolean;
}) {
  const { t } = useTranslation();
  const change = (index: number, patch: Partial<HandoffTargetDraft>) =>
    update(targets.map((target, at) => (at === index ? { ...target, ...patch } : target)));
  return (
    <SettingCard
      dirty={dirty}
      title={t('다른 서비스로 보내기')}
      description={t(
        '공간을 문서로 넘길 수 있는 사내 서비스입니다. 비워 두면 캔버스에 보내기 메뉴가 나타나지 않습니다. umm은 markdown만 보내므로, markdown을 받는 서비스만 메뉴에 오릅니다.',
      )}
      onSave={save}
      actions={
        <Button
          size="xs"
          variant="light"
          leftSection={<IconSend size={14} />}
          disabled={targets.length >= 20}
          onClick={() => update([...targets, { name: '', origin: '', formats: ['markdown'] }])}
        >
          {t('보낼 곳 추가')}
        </Button>
      }
    >
      {targets.length === 0 && <Text c="dimmed">{t('아직 보낼 곳이 없습니다.')}</Text>}
      {targets.map((target, index) => (
        <Paper key={index} withBorder radius="md" p="md">
          <Stack gap="sm">
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput
                label={t('이름')}
                description={t('메뉴에 보이는 이름입니다. 예: Ptium')}
                value={target.name}
                onChange={(e) => change(index, { name: e.currentTarget.value })}
              />
              <TextInput
                label={t('주소 (오리진)')}
                description={t('스킴과 호스트까지만, 경로 없이. 예: https://ptium.intra')}
                placeholder="https://ptium.intra"
                value={target.origin}
                onChange={(e) => change(index, { origin: e.currentTarget.value })}
              />
            </SimpleGrid>
            <Checkbox.Group
              label={t('받는 형식')}
              description={t('그 서비스가 받을 수 있는 형식입니다. markdown이 없으면 메뉴에 오르지 않습니다.')}
              value={target.formats}
              onChange={(formats) => change(index, { formats })}
            >
              <Group mt="xs" gap="md">
                {handoffFormats.map((format) => (
                  <Checkbox key={format} value={format} label={format} />
                ))}
              </Group>
            </Checkbox.Group>
            <Group justify="flex-end">
              <Button
                size="xs"
                variant="subtle"
                color="red"
                leftSection={<IconTrash size={14} />}
                onClick={() => update(targets.filter((_, at) => at !== index))}
              >
                {t('지우기')}
              </Button>
            </Group>
          </Stack>
        </Paper>
      ))}
    </SettingCard>
  );
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
                  '그 다음 아래 임베딩 Gateway 주소에 http://embeddings:11434 을, 임베딩 모델에 bge-m3 을 넣고 저장한 뒤 다시 측정하세요. 채팅 모델 주소는 그대로 두면 됩니다. 후보 모델 비교는 docs/ADMIN_GUIDE.md에 있습니다.',
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

/**
 * Spaces, and who can reach them.
 *
 * The reason this exists is the row with a struck-through owner: someone left,
 * their account was deactivated, and everything they owned stayed theirs. The
 * metrics screen counted those spaces and said nothing was wrong.
 */
function SpacesPanel({
  spaces,
  loading,
  orphanOnly,
  members,
  users,
  onOrphanOnly,
  onReload,
  onExpand,
  onTransfer,
}: {
  spaces: AdminSpace[];
  loading: boolean;
  orphanOnly: boolean;
  members: Record<string, SpaceMember[]>;
  users: AdminUser[];
  onOrphanOnly: (next: boolean) => void;
  onReload: () => void;
  onExpand: (spaceId: string) => Promise<void>;
  onTransfer: (space: AdminSpace, userId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState('');
  const [target, setTarget] = useState<Record<string, string>>({});
  const active = users.filter((u) => u.active !== false);
  return (
    <Card radius="lg" withBorder p="xl">
      <Group align="center" gap="sm" mb="lg" wrap="wrap">
        <Switch
          label={t('떠난 사람이 소유한 공간만')}
          checked={orphanOnly}
          onChange={(e) => onOrphanOnly(e.currentTarget.checked)}
        />
        <Button variant="light" loading={loading} onClick={onReload}>
          {t('새로 고침')}
        </Button>
      </Group>
      {spaces.length === 0 && !loading ? (
        <Text c="dimmed">{orphanOnly ? t('떠난 사람이 소유한 공간이 없습니다.') : t('공간이 없습니다.')}</Text>
      ) : (
        <Table.ScrollContainer minWidth={820}>
          <Table verticalSpacing="sm" striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('공간')}</Table.Th>
                <Table.Th>{t('소유자')}</Table.Th>
                <Table.Th>{t('참여자')}</Table.Th>
                <Table.Th>{t('생각')}</Table.Th>
                <Table.Th>{t('소유자 넘기기')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {spaces.map((space) => (
                <>
                  <Table.Tr key={space.id}>
                    <Table.Td>
                      <Group gap="xs">
                        <Text fw={600}>{space.name}</Text>
                        {space.isInbox && (
                          <Badge size="xs" variant="light" color="gray">
                            {t('수집함')}
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Group gap="xs">
                        <Text>{space.owner}</Text>
                        {!space.ownerActive && (
                          <Badge size="xs" color="red" variant="light">
                            {t('비활성')}
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Button
                        size="xs"
                        variant="subtle"
                        onClick={() => {
                          const next = open === space.id ? '' : space.id;
                          setOpen(next);
                          if (next) void onExpand(space.id);
                        }}
                      >
                        {space.members}
                      </Button>
                    </Table.Td>
                    <Table.Td>{space.notes}</Table.Td>
                    <Table.Td>
                      {space.isInbox ? (
                        <Text size="xs" c="dimmed">
                          {t('개인 공간')}
                        </Text>
                      ) : (
                        <Group gap="xs" wrap="nowrap">
                          <Select
                            size="xs"
                            placeholder={t('사람 고르기')}
                            searchable
                            w={170}
                            data={active.map((u) => ({ value: u.id, label: u.username }))}
                            value={target[space.id] || null}
                            onChange={(v) => setTarget((all) => ({ ...all, [space.id]: v || '' }))}
                          />
                          <Button
                            size="xs"
                            disabled={!target[space.id]}
                            onClick={() => void onTransfer(space, target[space.id])}
                          >
                            {t('넘기기')}
                          </Button>
                        </Group>
                      )}
                    </Table.Td>
                  </Table.Tr>
                  {open === space.id && (
                    <Table.Tr key={space.id + '-members'}>
                      <Table.Td colSpan={5}>
                        <Stack gap={4} pl="md">
                          {(members[space.id] || []).map((member) => (
                            <Group key={member.id} gap="xs">
                              <Text size="sm">{member.username}</Text>
                              <Badge size="xs" variant="light">
                                {member.permission}
                              </Badge>
                              {!member.active && (
                                <Badge size="xs" color="red" variant="light">
                                  {t('비활성')}
                                </Badge>
                              )}
                            </Group>
                          ))}
                          {!members[space.id] && (
                            <Text size="sm" c="dimmed">
                              {t('불러오는 중…')}
                            </Text>
                          )}
                        </Stack>
                      </Table.Td>
                    </Table.Tr>
                  )}
                </>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Card>
  );
}

/**
 * Every webhook in the installation, worst first.
 *
 * The metrics screen carried one number — deliveries failed in the last day.
 * Which webhook, whose, and failing with what were all recorded and none of
 * them shown, so the number said something was wrong and nothing about where
 * to look.
 */
function WebhookHealthPanel({
  webhooks,
  loading,
  failingOnly,
  onFailingOnly,
  onReload,
  onPause,
}: {
  webhooks: AdminWebhook[];
  loading: boolean;
  failingOnly: boolean;
  onFailingOnly: (next: boolean) => void;
  onReload: () => void;
  onPause: (hook: AdminWebhook) => Promise<void>;
}) {
  const { t, formatDate } = useTranslation();
  return (
    <Card radius="lg" withBorder p="xl">
      <Group align="center" gap="sm" mb="lg" wrap="wrap">
        <Switch
          label={t('실패한 것만')}
          checked={failingOnly}
          onChange={(e) => onFailingOnly(e.currentTarget.checked)}
        />
        <Button variant="light" loading={loading} onClick={onReload}>
          {t('새로 고침')}
        </Button>
      </Group>
      {webhooks.length === 0 && !loading ? (
        <Text c="dimmed">{failingOnly ? t('실패한 웹훅이 없습니다.') : t('등록된 웹훅이 없습니다.')}</Text>
      ) : (
        <Table.ScrollContainer minWidth={900}>
          <Table verticalSpacing="sm" striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('웹훅')}</Table.Th>
                <Table.Th>{t('주인')}</Table.Th>
                <Table.Th>{t('보내는 곳')}</Table.Th>
                <Table.Th>{t('연속 실패')}</Table.Th>
                <Table.Th>{t('최근 24시간 실패')}</Table.Th>
                <Table.Th>{t('마지막 전송')}</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {webhooks.map((hook) => (
                <Table.Tr key={hook.id}>
                  <Table.Td>
                    <Group gap="xs">
                      <Text fw={600}>{hook.name}</Text>
                      {!hook.active && (
                        <Badge size="xs" color="gray" variant="light">
                          {t('멈춤')}
                        </Badge>
                      )}
                    </Group>
                    {hook.lastError && (
                      <Text size="xs" c="red" mt={4} style={{ whiteSpace: 'pre-wrap' }}>
                        {hook.lastError}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Group gap="xs">
                      <Text size="sm">{hook.owner}</Text>
                      {!hook.ownerActive && (
                        <Badge size="xs" color="red" variant="light">
                          {t('비활성')}
                        </Badge>
                      )}
                    </Group>
                  </Table.Td>
                  {/* The host only: a hook address with a token in its path is
                      itself the secret, and an administrator needs to know where
                      deliveries go, not how to make one. */}
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {hook.destination}
                    </Text>
                  </Table.Td>
                  <Table.Td>{hook.failureCount}</Table.Td>
                  <Table.Td>{hook.failed24h}</Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {hook.lastDeliveredAt ? formatDate(hook.lastDeliveredAt) : t('없음')}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    {hook.active && (
                      <Button size="xs" variant="light" color="red" onClick={() => void onPause(hook)}>
                        {t('멈추기')}
                      </Button>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Card>
  );
}

/**
 * What the two bands above would do to the thoughts already here.
 *
 * A band is standard deviations above the mean of a space's own scores, so what
 * a given number does depends entirely on the corpus. The only way to find out
 * used to be to save it and go and look — by which time every canvas in the
 * installation had already changed, and the person who changed it found out
 * last.
 */
function BandPreviewCard({
  preview,
  loading,
  error,
  onPreview,
}: {
  preview: BandPreview | null;
  loading: boolean;
  error: string;
  onPreview: () => void;
}) {
  const { t } = useTranslation();
  const row = (label: string, current: number, proposed: number, lowerIsBetter = false) => {
    const moved = proposed !== current;
    const worse = lowerIsBetter ? proposed > current : proposed < current;
    return (
      <Table.Tr key={label}>
        <Table.Td>{label}</Table.Td>
        <Table.Td>{current}</Table.Td>
        <Table.Td c={!moved ? undefined : worse ? 'red' : 'teal'} fw={moved ? 600 : undefined}>
          {proposed}
          {moved && ` (${proposed > current ? '+' : ''}${proposed - current})`}
        </Table.Td>
      </Table.Tr>
    );
  };
  return (
    <Card radius="md" withBorder p="md" mt="md">
      <Group justify="space-between" align="center" wrap="wrap" gap="sm">
        <Text fw={600}>{t('지금 데이터로 미리 보기')}</Text>
        <Button variant="light" loading={loading} onClick={onPreview}>
          {t('지금 값으로 재보기')}
        </Button>
      </Group>
      <Text size="sm" c="dimmed" mt={4}>
        {t('저장하지 않고 위 두 기준이 지금 있는 생각에 무엇을 할지 재봅니다.')}
      </Text>
      {error && (
        <Alert color="red" variant="light" mt="sm">
          {error}
        </Alert>
      )}
      {preview && (
        <>
          <Text size="sm" c="dimmed" mt="sm">
            {t('가장 큰 공간 {spaces}개 · 생각 {notes}개 중 임베딩된 {embedded}개로 재봤습니다.', {
              spaces: preview.spaces,
              notes: preview.notes,
              embedded: preview.embedded,
            })}
          </Text>
          {/* Without a semantic backend the canvas groups by position, so the
              cluster band changes nothing at all. Showing its numbers anyway
              would describe arithmetic nobody will see. */}
          {!preview.semantic && (
            <Alert color="yellow" variant="light" mt="sm">
              {t(
                '지금 임베딩은 의미 비교에 적합하지 않다고 판정돼 있습니다. 캔버스는 위치로 묶으므로 군집 기준은 아무 일도 하지 않습니다.',
              )}
            </Alert>
          )}
          {preview.embedded === 0 ? (
            <Alert color="yellow" variant="light" mt="sm">
              {t('임베딩된 생각이 없어 두 기준 모두 아직 아무것도 판정하지 않습니다.')}
            </Alert>
          ) : (
            <Table.ScrollContainer minWidth={520}>
              <Table verticalSpacing="xs" mt="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th />
                    <Table.Th>
                      {t('지금')} ({preview.current.relatedBand} / {preview.current.clusterBand})
                    </Table.Th>
                    <Table.Th>
                      {t('바꾸면')} ({preview.proposed.relatedBand} / {preview.proposed.clusterBand})
                    </Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {row(
                    t('연관 생각이 하나도 없는 카드'),
                    preview.current.withoutRelated,
                    preview.proposed.withoutRelated,
                    true,
                  )}
                  {row(t('카드당 연관 생각 (중앙값)'), preview.current.medianRelated, preview.proposed.medianRelated)}
                  {row(t('가장 많은 카드'), preview.current.mostRelated, preview.proposed.mostRelated)}
                  {/* Only when the cluster band is what the canvas will use.
                      The warning above already says it is not, and printing a
                      table of group counts underneath that sentence would take
                      it straight back. */}
                  {preview.semantic && (
                    <>
                      {row(t('묶음 수'), preview.current.clusters, preview.proposed.clusters)}
                      {row(t('묶인 생각'), preview.current.grouped, preview.proposed.grouped)}
                      {row(t('가장 큰 묶음'), preview.current.largestCluster, preview.proposed.largestCluster)}
                      {row(t('혼자 남는 생각'), preview.current.ungrouped, preview.proposed.ungrouped, true)}
                    </>
                  )}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
        </>
      )}
    </Card>
  );
}
