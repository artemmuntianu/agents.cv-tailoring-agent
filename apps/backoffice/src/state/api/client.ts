/** The one client-side fetch wrapper the whole state layer goes through. */
import type {
  ActionRequest,
  ArchiveRequest,
  BoardAction,
  BoardCard,
  DetailsRequest,
  HistoryEntryRequest,
  InterviewRequest,
  MoveRequest,
} from '../../lib/types';
import type { VocabularyKind } from '../../lib/admin';

import type { AdminVocabulary } from '../admin/slice';
import type { CoverPayload } from '../cover/slice';

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** The 8h session expired: the caller redirects instead of showing an error. */
export class SessionExpiredError extends ApiError {
  constructor() {
    super('session expired', 401);
    this.name = 'SessionExpiredError';
  }
}

export type ApiEnvelope = { ok: boolean; error?: string };
export type WriteResult = { ok: true; note?: string };

/**
 * `fetch` plus the two rules every route expects: a non-GET carries a JSON content-type
 * (Astro's `checkOrigin` refuses one without it), and a non-2xx or `{ ok: false }` answer is
 * thrown as `ApiError`.
 */
export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  const upload = typeof FormData !== 'undefined' && init.body instanceof FormData;
  if (method !== 'GET' && !upload && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const response = await fetch(path, { ...init, method, headers });
  if (response.status === 401) throw new SessionExpiredError();

  let payload: (ApiEnvelope & Partial<T>) | null = null;
  try {
    payload = (await response.json()) as ApiEnvelope & Partial<T>;
  } catch {
    payload = null;
  }
  if (!response.ok || !payload || payload.ok === false) {
    throw new ApiError(payload?.error ?? `HTTP ${response.status}`, response.status);
  }
  return payload as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const patch = <T>(path: string, body?: unknown) =>
  request<T>(path, {
    method: 'PATCH',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const remove = <T>(path: string) => request<T>(path, { method: 'DELETE' });

export const api = {
  getBoard: () => request<{ ok: true; cards: BoardCard[] }>('/api/board'),
  getActions: () => request<{ ok: true; actions: BoardAction[] }>('/api/board/actions'),
  getCover: (jobId: string) =>
    request<{ ok: true } & CoverPayload>(`/api/cover/${encodeURIComponent(jobId)}`),
  askCover: (jobId: string) => post<WriteResult>(`/api/cover/${encodeURIComponent(jobId)}`),

  getAdminVocabulary: () => request<{ ok: true } & AdminVocabulary>('/api/admin/vocabulary'),
  adminAdd: (value: string, kind: VocabularyKind) =>
    post<WriteResult>('/api/admin/actions', { value, kind }),
  adminRename: (from: string, to: string) =>
    patch<WriteResult>('/api/admin/actions', { from, to }),
  adminRemove: (value: string) =>
    request<WriteResult>(`/api/admin/actions?value=${encodeURIComponent(value)}`, {
      method: 'DELETE',
    }),

  move: (body: MoveRequest & { interview?: InterviewRequest }) =>
    post<WriteResult>('/api/board/move', body),
  recordAction: (body: ActionRequest) => post<WriteResult>('/api/board/action', body),
  archive: (body: ArchiveRequest) => post<WriteResult>('/api/board/archive', body),
  restore: (jobId: string) => post<WriteResult>('/api/board/restore', { jobId }),
  remove: (jobId: string) => post<WriteResult>('/api/board/remove', { jobId }),

  addInterview: (jobId: string, body: InterviewRequest) =>
    post<WriteResult>('/api/board/interviews', { jobId, ...body }),
  editInterview: (id: number, body: InterviewRequest) =>
    patch<WriteResult>(`/api/board/interviews/${id}`, body),
  removeInterview: (id: number) => remove<WriteResult>(`/api/board/interviews/${id}`),

  editHistory: (id: number, body: HistoryEntryRequest) =>
    patch<WriteResult>(`/api/board/history/${id}`, body),
  removeHistory: (id: number) => remove<WriteResult>(`/api/board/history/${id}`),

  saveDetails: (body: DetailsRequest) => post<WriteResult>('/api/board/details', body),
  uploadDocx: (jobId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<WriteResult>(`/api/board/docx/${encodeURIComponent(jobId)}`, {
      method: 'POST',
      body: form,
    });
  },
};

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/** The login page sends the operator back here after signing in. */
export function redirectToLogin(next: string): void {
  if (typeof window !== 'undefined') {
    window.location.assign(`/login?next=${encodeURIComponent(next)}`);
  }
}