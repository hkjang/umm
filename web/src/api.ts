import { msg, translate } from './i18n/translate';
import { showError } from './ui-notifications';
import { readLocalStorage, removeLocalStorage, writeLocalStorage, type StorageRead } from './lib/browser-storage';
import {
  isTerminalOfflineRejection,
  mergeOfflineQueues,
  reconcileOfflineQueue,
  type OfflineMutation,
} from './offline-queue';

export interface Meta {
  serviceName: string;
  version: string;
  oidcEnabled: boolean;
  dreamEnabled: boolean;
  dreamAllowUserDisable: boolean;
  mcpProtocol: string;
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  email: string;
  role: 'user' | 'team_lead' | 'admin';
  teamId?: string;
  active: boolean;
}

export interface Space {
  id: string;
  ownerId: string;
  name: string;
  color: string;
  aiExcluded: boolean;
  /** Where unfiled captures land. An ordinary space in every other respect. */
  isInbox: boolean;
  /** What the person asking may do here. Absent from older servers. */
  permission?: 'manage' | 'edit' | 'view';
}

/** What a thought is. The server rejects anything outside this. */
export type NoteKind = 'thought' | 'question' | 'idea';

export interface ThoughtNote {
  id: string;
  spaceId: string;
  authorId: string;
  content: string;
  title: string;
  color: string;
  kind: NoteKind;
  source: 'user' | 'dream' | 'api' | 'mcp';
  aiExcluded: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  relatedCount: number;
}

export interface NoteComment {
  id: string;
  noteId: string;
  authorId: string;
  author: string;
  username: string;
  parentId?: string;
  body: string;
  mentions: string[];
  resolvedAt?: string;
  resolvedBy?: string;
  createdAt: string;
  updatedAt: string;
}

/** The connection vocabulary. The server rejects anything outside it. */
export type EdgeRelation = 'related' | 'supports' | 'contradicts' | 'refines' | 'expands' | 'follows';

/** Who made the connection. Set by the server; never sent by the client. */
export type EdgeOrigin = 'manual' | 'agent' | 'dream' | 'development' | 'import' | 'auto';

export interface ThoughtEdge {
  id: string;
  spaceId: string;
  source: string;
  target: string;
  relation: EdgeRelation;
  origin: EdgeOrigin;
  /** Present only on inferred edges; a drawn line carries no probability. */
  confidence?: number;
  /**
   * Why this connection was drawn, in the words of whoever drew it. The
   * relation says what kind of connection it is; nothing else says why, and
   * that is the half that disappears first.
   *
   * Empty is the normal case and means its author did not feel the need — not
   * that a reason is missing. Never render it as an absence.
   */
  reason?: string;
}

/** Why a suggestion run produced what it did — including when it produced nothing. */
export type SuggestionOutcome =
  | 'suggested'
  | 'no-candidates'
  | 'backend-not-semantic'
  | 'too-few-notes'
  /** A space this person may read but not change. Suggesting writes edges. */
  | 'read-only'
  | 'disabled';

export interface SuggestionResult {
  outcome: SuggestionOutcome;
  edges: ThoughtEdge[];
  /** Pairs scored, so a quiet result is distinguishable from no attempt. */
  considered: number;
}

/** Where a captured thought might belong, and what the ranking rests on. */
export interface SpaceSuggestion {
  space: Space;
  score: number;
  /** 'meaning' when umm can judge closeness; 'recent' when it cannot and says so. */
  basis: 'meaning' | 'recent';
}

/** What accumulated while you were away. */
export interface MorningBrief {
  since: string;
  dreams: { kind: string; count: number }[];
  suggestions: number;
  unfiled: number;
  duplicates: {
    spaceId: string;
    space: string;
    first: ThoughtNote;
    second: ThoughtNote;
    score: number;
    /**
     * Present when exactly one of the two sits in a line that was decided
     * against. The pair then means something other than "written twice": work
     * is being redone that someone already chose not to do.
     */
    setAside?: { id: string; name: string; status: string; resolution?: string };
    setAsideNoteId?: string;
  }[];
  /** What umm did not examine — so an empty list above is not read as an all-clear. */
  skipped: { kind: string; reason: 'backend-not-semantic' | 'disabled' | 'space-too-large' }[];
  /**
   * Disagreements someone recorded. umm does not detect these, so an empty list
   * means nobody has marked any — not that the workspace has none. The interface
   * shows nothing at all rather than a zero.
   */
  contradictions: {
    edgeId: string;
    spaceId: string;
    space: string;
    claim: ThoughtNote;
    counter: ThoughtNote;
    origin: string;
  }[];
  /**
   * Questions marked open with nothing recorded as answering them. Both halves
   * are marked rather than inferred, so an empty list means nothing is marked
   * open — not that everything has been answered.
   */
  questions: { note: ThoughtNote; spaceId: string; space: string; attempts: number }[];
  /** Nothing to report *and* nothing skipped. */
  quiet: boolean;
}

/** An embedding gateway umm found at one of the addresses it documents. */
export interface GatewayCandidate {
  baseUrl: string;
  models: {
    name: string;
    /** A hint from the name, not a finding — the connection test settles it. */
    likelyEmbedding: boolean;
  }[];
}

/** A group of thoughts, and what grouped them. */
export interface Cluster {
  id: string;
  label: string;
  noteIds: string[];
  cohesion: number;
  /** 'meaning' when umm read the notes; 'proximity' when it read the layout and says so. */
  basis: 'meaning' | 'proximity';
}

/** What a merge moved, so a caller can say what happened to the thought. */
export interface MergeResult {
  note: ThoughtNote;
  movedEdges: number;
  /** Self-links and duplicates the survivor already had. */
  droppedEdges: number;
  movedComments: number;
}

export interface NoteSearchResult {
  id: string;
  spaceId: string;
  spaceName: string;
  title: string;
  content: string;
  kind: string;
  updatedAt: string;
  score: number;
  reason: string;
}

export type EdgeStyle = 'bezier' | 'smoothstep' | 'straight';

export interface Preferences {
  dream_enabled: boolean;
  dream_frequency: string;
  dream_style: string;
  dream_notifications: boolean;
  include_old_notes: boolean;
  dream_pause_until?: string;
  theme: string;
  locale: string;
  edge_style: EdgeStyle;
  review_digest: boolean;
}

export class APIError extends Error {
  constructor(
    public status: number,
    message: string,
    public payload: Record<string, any> = {},
    public queued = false,
  ) {
    super(message);
  }
}

export interface APIOptions extends RequestInit {
  silent?: boolean;
  queueIfOffline?: boolean;
  retry?: boolean;
}

const offlineKey = 'umm:offline-mutations:v1';
const offlineOwnerKey = 'umm:offline-owner:v1';
const mutationMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const requestID = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
type QueueRead = { available: boolean; items: OfflineMutation[] };
type OfflineEnqueueResult = 'queued' | 'full' | 'unavailable';

// The in-memory owner keeps this tab stable when a sandboxed/private browser
// refuses storage access. Before authentication resolves, a persisted owner is
// used when it can be read safely.
let activeOfflineOwner: string | undefined;
let offlineOwnerResolved = false;
function resolveOfflineOwner(): string | undefined {
  if (!offlineOwnerResolved) {
    const stored: StorageRead = readLocalStorage(offlineOwnerKey);
    if (stored.available) {
      activeOfflineOwner = stored.value || undefined;
      offlineOwnerResolved = true;
    }
  }
  return activeOfflineOwner;
}
const queueStorageKey = () => `${offlineKey}:${resolveOfflineOwner() || 'anonymous'}`;

function readOfflineQueue(storageKey = queueStorageKey()): QueueRead {
  const stored = readLocalStorage(storageKey);
  if (!stored.available) return { available: false, items: [] };
  try {
    const value = JSON.parse(stored.value || '[]');
    return Array.isArray(value) ? { available: true, items: value } : { available: false, items: [] };
  } catch {
    // Do not overwrite an unreadable queue with an apparently empty one.
    return { available: false, items: [] };
  }
}

function loadOfflineQueue(storageKey = queueStorageKey()): OfflineMutation[] {
  return readOfflineQueue(storageKey).items;
}

function saveOfflineQueue(items: OfflineMutation[], storageKey = queueStorageKey()): boolean {
  if (!writeLocalStorage(storageKey, JSON.stringify(items))) return false;
  const count = storageKey === queueStorageKey() ? items.length : offlineQueueCount();
  window.dispatchEvent(new CustomEvent('umm:offline-queue', { detail: { count } }));
  return true;
}

async function withOfflineQueueLock<T>(storageKey: string, operation: () => T | Promise<T>): Promise<T> {
  if (!navigator.locks?.request) return operation();
  return navigator.locks.request(`${storageKey}:lock`, operation);
}

export async function setOfflineQueueOwner(userId?: string) {
  activeOfflineOwner = userId;
  offlineOwnerResolved = true;
  if (userId) {
    const target = `${offlineKey}:${userId}`;
    // Current tabs use the target lock for queue writes. The legacy lock also
    // serialises simultaneous migrations, so an existing account queue is
    // reconciled with late writes from an older app before legacy is removed.
    await withOfflineQueueLock(offlineKey, () =>
      withOfflineQueueLock(target, () => {
        const legacy = readOfflineQueue(offlineKey);
        const account = readOfflineQueue(target);
        if (legacy.available && account.available) {
          const migrated =
            legacy.items.length === 0 ||
            writeLocalStorage(target, JSON.stringify(mergeOfflineQueues(account.items, legacy.items)));
          if (migrated) removeLocalStorage(offlineKey);
        }
        writeLocalStorage(offlineOwnerKey, userId);
      }),
    );
  } else {
    await withOfflineQueueLock(offlineKey, () => removeLocalStorage(offlineOwnerKey));
  }
  window.dispatchEvent(new CustomEvent('umm:offline-queue', { detail: { count: offlineQueueCount() } }));
}

async function enqueueOffline(item: OfflineMutation): Promise<OfflineEnqueueResult> {
  const storageKey = queueStorageKey();
  return withOfflineQueueLock(storageKey, () => {
    const current = readOfflineQueue(storageKey);
    if (!current.available) return 'unavailable';
    let items = current.items;
    if (item.method === 'PUT' || item.method === 'PATCH') {
      items = items.filter((queued) => !(queued.path === item.path && queued.method === item.method));
    }
    if (items.length >= 100) return 'full';
    items.push(item);
    return saveOfflineQueue(items, storageKey) ? 'queued' : 'unavailable';
  });
}

export const offlineQueueCount = () => loadOfflineQueue().length;

export async function discardOfflineMutation(id?: string) {
  if (!id) return;
  raisedConflicts.delete(id);
  const storageKey = queueStorageKey();
  await withOfflineQueueLock(storageKey, () => {
    const current = readOfflineQueue(storageKey);
    if (!current.available) return;
    saveOfflineQueue(
      current.items.filter((item) => item.id !== id),
      storageKey,
    );
  });
}

/**
 * problemMessage localises the RFC 9457 problems the API is known to return.
 *
 * The server writes its messages in Korean, so a known `type` is translated by
 * its stable identifier and anything unrecognised falls back to the server's
 * own wording rather than being dropped.
 */
const problemTitles: Record<string, string> = {
  'rate-limited': msg('요청이 너무 많습니다'),
  'ai-rate-limited': msg('AI 요청이 너무 잦습니다'),
  'ai-daily-limit': msg('오늘의 AI 사용량을 모두 썼습니다'),
  'login-locked': msg('로그인이 일시적으로 잠겼습니다'),
  'note-version-conflict': msg('메모 변경이 겹쳤습니다'),
  'comment-mutation-forbidden': msg('댓글 변경 권한이 없습니다'),
};

export function problemMessage(payload: Record<string, any>): string {
  const identifier = typeof payload?.type === 'string' ? payload.type.split('/').pop() || '' : '';
  const known = problemTitles[identifier];
  if (known) return translate(known);
  return payload?.detail || payload?.error || '';
}

const isIdempotencyInProgress = (payload: Record<string, any>) =>
  typeof payload?.type === 'string' && payload.type.endsWith('/idempotency-in-progress');

const retryableOfflineStatus = (status: number) => status === 408 || status === 425 || status === 429 || status >= 500;

// How long to wait before coming back to a queue a flush left work in, when the
// thing that held it up clears by itself and the browser will not say so.
//
// An `online` event is the only thing that brings a flush back unasked, and it
// fires when connectivity returns — not when another tab finishes writing the
// same change, and not when a request throws while the browser still believes
// it is connected. Without a timer those two leave the change sitting in the
// queue, under a banner that says it is waiting for a connection the reader
// already has, until somebody presses sync.
//
// A reservation held by another request is measured in the time that request
// takes; a server or a network that faltered is given the same five seconds the
// retryable statuses default to.
const inProgressRetrySeconds = 2;
const unreachableRetrySeconds = 5;
let offlineRetryTimer: number | undefined;

function scheduleOfflineRetry(delaySeconds: number) {
  if (offlineRetryTimer !== undefined) return;
  offlineRetryTimer = window.setTimeout(
    () => {
      offlineRetryTimer = undefined;
      if (navigator.onLine) void flushOfflineQueue();
    },
    Math.max(1, Math.min(delaySeconds, 300)) * 1000,
  );
}

async function fetchAPI(path: string, requestOptions: RequestInit, retry: boolean): Promise<Response> {
  try {
    return await fetch(`/api/v1${path}`, { credentials: 'same-origin', ...requestOptions });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    if (!retry) throw cause;
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    return fetch(`/api/v1${path}`, { credentials: 'same-origin', ...requestOptions });
  }
}

export async function api<T>(path: string, options: APIOptions = {}): Promise<T> {
  const { silent = false, queueIfOffline = false, retry, ...requestOptions } = options;
  const method = (requestOptions.method || 'GET').toUpperCase();
  const headers = new Headers(requestOptions.headers);
  if (requestOptions.body) headers.set('Content-Type', 'application/json');
  if (queueIfOffline && mutationMethods.has(method) && !headers.has('Idempotency-Key'))
    headers.set('Idempotency-Key', `web:${requestID()}`);
  const normalizedOptions = { ...requestOptions, method, headers };
  let response: Response;
  try {
    response = await fetchAPI(path, normalizedOptions, retry ?? (method === 'GET' || headers.has('Idempotency-Key')));
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    if (queueIfOffline && mutationMethods.has(method) && typeof requestOptions.body !== 'object') {
      const safeHeaders: Record<string, string> = {};
      for (const name of ['Content-Type', 'Idempotency-Key']) {
        const value = headers.get(name);
        if (value) safeHeaders[name] = value;
      }
      let queueResult: OfflineEnqueueResult = 'unavailable';
      try {
        queueResult = await enqueueOffline({
          id: requestID(),
          path,
          method,
          body: requestOptions.body as string | undefined,
          headers: safeHeaders,
          createdAt: new Date().toISOString(),
        });
      } catch {
        // Web Locks or browser storage can be denied independently. In either
        // case the optimistic mutation is not durable and must not be reported
        // as queued.
      }
      if (queueResult !== 'queued') {
        const storageUnavailable = queueResult === 'unavailable';
        const error = new APIError(
          0,
          storageUnavailable
            ? translate(
                '오프라인 변경을 브라우저에 안전하게 저장하지 못했습니다. 저장 공간과 사이트 권한을 확인한 뒤 다시 시도해 주세요.',
              )
            : translate('오프라인 보관함이 100개로 가득 찼습니다. 연결 후 동기화를 완료하고 다시 시도해 주세요.'),
          { type: storageUnavailable ? 'offline-storage-unavailable' : 'offline-queue-full' },
        );
        if (!silent)
          showError(
            error.message,
            translate(storageUnavailable ? '오프라인 저장 실패' : '오프라인 보관함 가득 참'),
            `api:${path}:${storageUnavailable ? 'queue-unavailable' : 'queue-full'}`,
          );
        throw error;
      }
      const error = new APIError(
        0,
        translate('오프라인 보관함에 저장했습니다. 연결되면 자동으로 다시 시도합니다.'),
        {},
        true,
      );
      if (!silent) showError(error.message, translate('오프라인 저장'), `api:${path}:queued`);
      throw error;
    }
    const error = new APIError(
      0,
      translate('서버에 연결할 수 없습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.'),
    );
    if (!silent) showError(error.message, translate('연결 오류'), `api:${path}:network`);
    throw error;
  }
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new APIError(
      response.status,
      problemMessage(payload) || translate('요청에 실패했습니다 ({status})', { status: response.status }),
      payload,
    );
    if (!silent) showError(error.message, translate('요청 오류'), `api:${path}:${response.status}`);
    throw error;
  }
  return payload as T;
}

export interface FlushResult {
  synced: number;
  remaining: number;
}

/**
 * Guards against overlapping flushes started inside this tab.
 *
 * The Web Lock below serialises the queue reads and writes across tabs, but the
 * replay loop itself runs outside it. Reconnecting fires the browser's own
 * `online` event while a screen may also ask for a manual sync, and two flushes
 * replaying the same mutation made the second one collide with the first one's
 * in-flight idempotency reservation — surfacing a version-conflict dialog for a
 * change that was being applied correctly. Callers now share one flush.
 */
let inFlightFlush: Promise<FlushResult> | undefined;

/**
 * Mutations whose version conflict has already been put in front of the reader,
 * each held with the event that describes it.
 *
 * A conflict is a decision, not a delay. The queued change carries the version
 * it was written against, so replaying it answers 409 for as long as it exists
 * — and every replay raises the event again, which reopens the merge dialog and
 * throws away whatever the person had typed into it. So a change that raised a
 * conflict is held, counted and left alone until they choose; resolving it,
 * whichever way, discards the mutation and takes it out of here.
 *
 * Keeping the event, not just the id, is what keeps that decision reachable.
 * `umm:offline-conflict` is raised once, and the only screen that answers it is
 * the canvas — which may be closed, or showing another space, at that moment.
 * Nobody hears it, nothing raises it again, and the change sits in the queue
 * for good: skipped by every flush, and reported by the banner as waiting for a
 * connection the reader already has. `replayOfflineConflicts` asks again.
 */
const raisedConflicts = new Map<string, { item: OfflineMutation; payload: Record<string, any> }>();

/** How many queued changes are held on a decision rather than on a connection. */
export const offlineConflictCount = () => raisedConflicts.size;

/**
 * Why the last flush stopped with work still queued, when the reason is neither
 * the network nor a merge decision.
 *
 * A 401 or a 403 halts the whole queue, and rightly so: every later change
 * carries the same cookie to the same server and would collect the same answer.
 * Staying quiet about it was the problem. The banner had one sentence for a
 * queue with anything left in it — waiting for a connection — beside a sync
 * button that, for a session which had expired while the tab stayed open, could
 * only meet the same 401 again. So the person was told to wait for something
 * that had already arrived, and never told the one thing that would move their
 * writing: sign in again.
 *
 * `signed-out` is a session that ended; `refused` is a server that will not take
 * this change from this account, whatever the reason it gave. Each flush sets
 * this afresh, so it describes the queue as it stands rather than something that
 * was once true.
 */
export type OfflineBlock = 'signed-out' | 'refused';
let offlineBlock: OfflineBlock | undefined;
export const offlineBlockReason = (): OfflineBlock | undefined => offlineBlock;

/**
 * Raise every held conflict again, for a screen that can show it now.
 *
 * Safe to call whenever such a screen appears: it sends no request, so a change
 * already answered 409 is not asked about again on the server, and a listener
 * that is deciding one conflict ignores the rest.
 */
export function replayOfflineConflicts(): number {
  for (const detail of raisedConflicts.values())
    window.dispatchEvent(new CustomEvent('umm:offline-conflict', { detail }));
  return raisedConflicts.size;
}

export function flushOfflineQueue(): Promise<FlushResult> {
  inFlightFlush ??= runFlush().finally(() => {
    inFlightFlush = undefined;
  });
  return inFlightFlush;
}

async function runFlush(): Promise<FlushResult> {
  offlineBlock = undefined;
  const storageKey = queueStorageKey();
  const snapshot = await withOfflineQueueLock(storageKey, () => readOfflineQueue(storageKey));
  if (!snapshot.available) return { synced: 0, remaining: 0 };
  const queued = snapshot.items;
  if (queued.length === 0 || !navigator.onLine) return { synced: 0, remaining: queued.length };
  const remaining: OfflineMutation[] = [];
  let synced = 0;
  let retryAfterSeconds = 0;
  for (let index = 0; index < queued.length; index += 1) {
    const item = queued[index];
    if (raisedConflicts.has(item.id)) {
      remaining.push(item);
      continue;
    }
    try {
      const response = await fetch(`/api/v1${item.path}`, {
        credentials: 'same-origin',
        method: item.method,
        body: item.body,
        headers: item.headers,
      });
      if (response.ok) {
        synced += 1;
        continue;
      }
      const payload = await response.json().catch(() => ({}));
      if (response.status === 409) {
        remaining.push(item);
        // A reservation that is still in progress is not a version conflict:
        // the same change is already being applied, so it must be retried
        // rather than shown to the reader as two competing versions.
        if (isIdempotencyInProgress(payload)) {
          retryAfterSeconds = Math.max(retryAfterSeconds, inProgressRetrySeconds);
          continue;
        }
        raisedConflicts.set(item.id, { item, payload });
        window.dispatchEvent(new CustomEvent('umm:offline-conflict', { detail: { item, payload } }));
        continue;
      }
      if (isTerminalOfflineRejection(response.status, payload.type)) {
        const reason =
          problemMessage(payload) || translate('서버가 변경을 거부했습니다 ({status}).', { status: response.status });
        showError(reason, translate('오프라인 변경을 적용하지 못했습니다'), `offline:${item.id}:rejected`);
        window.dispatchEvent(
          new CustomEvent('umm:offline-rejected', { detail: { item, payload, status: response.status } }),
        );
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        // Stopping here is right — the rest of the queue would meet the same
        // answer — but the queue is then held on something no amount of waiting
        // or syncing resolves, so it says which of the two it is. The reason a
        // 403 gave is the server's own; a 401 has none worth repeating, and the
        // sentence that helps names what to do instead.
        offlineBlock = response.status === 401 ? 'signed-out' : 'refused';
        showError(
          offlineBlock === 'signed-out'
            ? translate('로그인이 만료되어 오프라인 변경을 보내지 못했습니다. 다시 로그인하면 이어서 보냅니다.')
            : problemMessage(payload) || translate('서버가 이 계정의 오프라인 변경을 받지 않았습니다.'),
          translate('오프라인 변경을 보내지 못했습니다'),
          `offline:blocked:${response.status}`,
        );
        remaining.push(item, ...queued.slice(index + 1));
        break;
      }
      // A permanent rejection is already handled above; what is left here is
      // the retryable half, which honours the server's Retry-After.
      if (retryableOfflineStatus(response.status)) {
        remaining.push(item);
        const requestedDelay = Number.parseInt(response.headers.get('Retry-After') || '5', 10);
        const retryDelay = Number.isFinite(requestedDelay) && requestedDelay > 0 ? requestedDelay : 5;
        retryAfterSeconds = Math.max(retryAfterSeconds, retryDelay);
        continue;
      }
      remaining.push(item);
    } catch {
      remaining.push(...queued.slice(index));
      // The browser going offline mid-flush raises its own event, and the
      // guard below skips the timer while it is offline. What is left is a
      // request that failed with the connection apparently intact.
      retryAfterSeconds = Math.max(retryAfterSeconds, unreachableRetrySeconds);
      break;
    }
  }
  const persistence = await withOfflineQueueLock(storageKey, () => {
    const current = readOfflineQueue(storageKey);
    if (!current.available) return { saved: false, items: queued };
    const next = reconcileOfflineQueue(queued, remaining, current.items);
    if (!saveOfflineQueue(next, storageKey)) return { saved: false, items: current.items };
    return { saved: true, items: next };
  });
  const reconciled = persistence.items;
  if (!persistence.saved) {
    showError(
      translate(
        '오프라인 변경을 브라우저에 안전하게 저장하지 못했습니다. 저장 공간과 사이트 권한을 확인한 뒤 다시 시도해 주세요.',
      ),
      translate('오프라인 저장 실패'),
      'offline:queue-unavailable',
    );
  }
  const snapshotIDs = new Set(queued.map((item) => item.id));
  const addedDuringFlush = reconciled.some((item) => !snapshotIDs.has(item.id));
  // A change that left the queue — resolved, discarded, or coalesced away — has
  // no conflict left to hold.
  const reconciledIDs = new Set(reconciled.map((item) => item.id));
  for (const id of raisedConflicts.keys()) if (!reconciledIDs.has(id)) raisedConflicts.delete(id);
  if (persistence.saved && navigator.onLine && reconciled.length > 0) {
    if (retryAfterSeconds > 0) scheduleOfflineRetry(retryAfterSeconds);
    else if (addedDuringFlush) scheduleOfflineRetry(1);
  }
  window.dispatchEvent(new CustomEvent('umm:offline-sync', { detail: { synced, remaining: reconciled.length } }));
  return { synced, remaining: reconciled.length };
}

export const json = (method: string, body?: unknown): APIOptions => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});
