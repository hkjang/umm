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

export class APIError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...options.headers } : options.headers,
  });
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new APIError(response.status, payload.error || `요청에 실패했습니다 (${response.status})`);
  return payload as T;
}

export const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});
