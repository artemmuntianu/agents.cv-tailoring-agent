import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, SessionExpiredError, request } from './client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the client fetch wrapper', () => {
  it('sends a JSON content-type on a body-less non-GET', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await request('/api/board/restore', { method: 'POST' });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Headers).get('content-type')).toBe('application/json');
  });

  it('does not set a content-type on GET', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, cards: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await request('/api/board');

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Headers).has('content-type')).toBe(false);
  });

  it('leaves a FormData body untouched so the browser writes the boundary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await request('/api/board/docx/1', { method: 'POST', body: new FormData() });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Headers).has('content-type')).toBe(false);
  });

  it('throws the route error when ok is false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: false, error: 'nope' }, 409)));

    await expect(request('/api/board/move', { method: 'POST' })).rejects.toThrowError(
      new ApiError('nope', 409),
    );
  });

  it('marks a 401 as a session expiry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: false, error: 'nope' }, 401)));

    await expect(request('/api/board')).rejects.toBeInstanceOf(SessionExpiredError);
  });
});