import { showError } from './ui-notifications';

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
}

export interface ThoughtNote {
  id: string;
  spaceId: string;
  authorId: string;
  content: string;
  title: string;
  color: string;
  kind: string;
  source: 'user' | 'dream' | 'api' | 'mcp';
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

export interface ThoughtEdge {
  id: string;
  spaceId: string;
  source: string;
  target: string;
  relation: string;
}

export interface NoteSearchResult {
  id: string;
  spaceId: string;
  spaceName: string;
  title: string;
  content: string;
  kind: string;
  updatedAt: string;
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
}

export class APIError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface APIOptions extends RequestInit { silent?: boolean; }

export async function api<T>(path: string, options: APIOptions = {}): Promise<T> {
  const { silent = false, ...requestOptions } = options;
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      credentials: 'same-origin',
      ...requestOptions,
      headers: requestOptions.body ? { 'Content-Type': 'application/json', ...requestOptions.headers } : requestOptions.headers,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    const error = new APIError(0, '서버에 연결할 수 없습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.');
    if (!silent) showError(error.message, '연결 오류', `api:${path}:network`);
    throw error;
  }
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new APIError(response.status, payload.error || `요청에 실패했습니다 (${response.status})`);
    if (!silent) showError(error.message, '요청 오류', `api:${path}:${response.status}`);
    throw error;
  }
  return payload as T;
}

export const json = (method: string, body?: unknown): APIOptions => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});
