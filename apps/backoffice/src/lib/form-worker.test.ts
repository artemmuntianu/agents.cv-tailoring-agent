import { afterEach, describe, expect, it } from 'vitest';
import { createFormWorker } from '../../../extension/src/form/worker.js';

/**
 * The form filler's *worker* half (`apps/extension/src/form/worker.js`) runs on `chrome.tabs` and
 * `fetch`, not on the DOM, so it is faked here rather than rendered: the rule that needs pinning
 * is **which card a page belongs to**.
 *
 * A page cannot always be looked up by its own vacancy id. A Djinni or DOU vacancy whose Apply
 * button opens the employer's own ATS form keeps `dou`/`351812` as its identity, so nothing on
 * that board is keyed on the Greenhouse job number: the connector is the card's own
 * **application URL** (`resume_board.apply_url`), which is what these three cases cover - the id
 * match wins when there is one, the URL match answers when there is not, and neither match stops
 * the flow instead of filling a form from a guess.
 */

const PAGE = 'https://job-boards.eu.greenhouse.io/growe/jobs/4987494101';
const LINKED_JOB = 'dou-351812-1';

interface Call {
  path: string;
  method: string;
}

/** A fake gateway (routed by path) and a fake page (answering the snapshot/apply messages). */
function harness(options: { known?: Record<string, unknown>; card?: unknown }) {
  const calls: Call[] = [];
  const globals = globalThis as unknown as Record<string, unknown>;

  globals.chrome = {
    runtime: { lastError: null },
    storage: {
      local: {
        get: async () => ({
          formRecipes: {
            'job-boards.eu.greenhouse.io': {
              root: { selector: '#application-form' },
              pins: {},
            },
          },
        }),
        remove: async () => {},
      },
    },
    tabs: {
      get: async () => ({ url: PAGE }),
      sendMessage: (_tabId: number, message: { action: string }, callback: (r: unknown) => void) =>
        callback(
          message.action === 'snapshot'
            ? { ok: true, root: {}, html: '<form></form>', fields: [{ id: 'f1', kind: 'text' }] }
            : { ok: true, filled: [], skipped: [], failed: [] },
        ),
    },
  };

  globals.fetch = async (url: string, init: RequestInit = {}) => {
    const path = String(url).replace('http://gateway.test', '');
    calls.push({ path, method: init.method ?? 'GET' });

    const body = path.startsWith('/api/vacancies/status')
      ? { ok: true, cvVersion: 'v1', known: options.known ?? {} }
      : path.startsWith('/api/vacancies/link')
        ? { ok: true, card: options.card ?? null }
        : path.includes('?schema=')
          ? {
              ok: true,
              status: 'completed',
              plan: { fields: [], undecided: [], note: '' },
              model: 'gemini-test',
            }
          : { ok: true, queued: true, status: 'queued', schemaHash: 'hash-1' };

    return { ok: true, status: 200, json: async () => body };
  };

  const worker = createFormWorker({
    settings: async () => ({ gateway: 'http://gateway.test', token: 'token', user: 'me' }),
    // The two helpers `background.js` injects: one fetch each, exactly as it builds them.
    cardStatus: async (message: { externalIds: string[] }) => {
      const path = `/api/vacancies/status?external_ids=${message.externalIds.join(',')}`;
      const response = await fetch(`http://gateway.test${path}`);
      return response.json();
    },
    cardForUrl: async (pageUrl: string) => {
      const path = `/api/vacancies/link?url=${encodeURIComponent(pageUrl)}`;
      const response = await fetch(`http://gateway.test${path}`);
      return response.json();
    },
  });

  return { worker, calls };
}

afterEach(() => {
  const globals = globalThis as unknown as Record<string, unknown>;
  delete globals.chrome;
  delete globals.fetch;
});

describe('which card an application page belongs to', () => {
  it('uses the page vacancy id when the card was scraped from that very site', async () => {
    const { worker, calls } = harness({ known: { '4987494101': { jobId: LINKED_JOB } } });

    const result = await worker.populate(1);

    expect(result.ok).toBe(true);
    expect(result.jobId).toBe(LINKED_JOB);
    expect(result.linkedBy).toBe('id');
    // The URL lookup is the fallback, so it must not even be asked.
    expect(calls.some((call) => call.path.startsWith('/api/vacancies/link'))).toBe(false);
  });

  it('falls back to the application URL when no row carries the ATS job number', async () => {
    const { worker, calls } = harness({
      known: {},
      card: { jobId: LINKED_JOB, externalId: '351812', source: 'dou', status: 'completed' },
    });

    const result = await worker.populate(1);

    expect(result.ok).toBe(true);
    expect(result.jobId).toBe(LINKED_JOB);
    expect(result.linkedBy).toBe('url');
    // The page URL travels whole (and encoded), so the board can canonicalise it its own way.
    expect(calls.find((call) => call.path.startsWith('/api/vacancies/link'))?.path).toBe(
      `/api/vacancies/link?url=${encodeURIComponent(PAGE)}`,
    );
  });

  it('stops instead of guessing when the page belongs to no card at all', async () => {
    const { worker, calls } = harness({ known: {}, card: null });

    const result = await worker.populate(1);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Application URL/);
    // Nothing was drafted and nothing was written into the page.
    expect(calls.some((call) => call.path.startsWith('/api/apply/'))).toBe(false);
  });
});
