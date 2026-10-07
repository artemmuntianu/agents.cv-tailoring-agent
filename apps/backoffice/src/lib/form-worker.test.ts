import { afterEach, describe, expect, it } from 'vitest';
import { createFormWorker } from '../../../extension/src/form/worker.js';
import { vacancyIdFromUrl, boardKeyForUrl } from '../../../extension/src/sites/index.js';

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
/** The DOU shape: its own vacancy URL, id after `/vacancies/` - card `375802`, 2026-10-07. */
const DOU_PAGE = 'https://jobs.dou.ua/companies/riseapps/vacancies/375802/';
const LINKED_JOB = 'dou-351812-1';

interface Call {
  path: string;
  method: string;
}

/** A fake gateway (routed by path), a fake page, and a real (in-memory) `chrome.storage.local`. */
function harness(options: {
  known?: Record<string, unknown>;
  card?: unknown;
  page?: string;
  /** Seed the two stores. Default: this host already holds a picked form. */
  storage?: { formRecipes?: Record<string, unknown>; formDefaults?: Record<string, unknown> };
}) {
  const calls: Call[] = [];
  const globals = globalThis as unknown as Record<string, unknown>;
  const page = options.page ?? PAGE;
  const pageHost = new URL(page).hostname;
  const store: Record<string, unknown> = {
    formRecipes: options.storage?.formRecipes ?? {
      [pageHost]: { root: { selector: '#application-form' }, pins: {} },
    },
    formDefaults: options.storage?.formDefaults ?? {},
  };

  globals.chrome = {
    runtime: { lastError: null },
    storage: {
      local: {
        get: async (keys?: string[]) => {
          if (!keys) return { ...store };
          const wanted: Record<string, unknown> = {};
          for (const key of keys) if (key in store) wanted[key] = store[key];
          return wanted;
        },
        set: async (patch: Record<string, unknown>) => {
          Object.assign(store, patch);
        },
        remove: async () => {},
      },
    },
    tabs: {
      get: async () => ({ url: page }),
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
    // The helpers `background.js` injects: the two fetch lookups exactly as it builds them, and the
    // registry's two answers about a page - its vacancy id and the **job board** it belongs to.
    vacancyIdFromUrl,
    boardKeyForUrl,
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

  return { worker, calls, store };
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

  it('reads a DOU page id from /vacancies/ instead of demanding an Application URL', async () => {
    // Card `375802` (dou, 2026-10-07): the vacancy is on the board and its own page is where the
    // operator stands, so the id alone must resolve it - `/jobs/(\d+)` never matched this URL, which
    // is what pushed the applier to "put this page's URL in its Application URL field".
    const { worker, calls } = harness({
      known: { '375802': { jobId: 'dou-375802-1' } },
      page: DOU_PAGE,
    });

    const result = await worker.populate(1);

    expect(result.ok).toBe(true);
    expect(result.jobId).toBe('dou-375802-1');
    expect(result.linkedBy).toBe('id');
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

/**
 * The other half of "these are the same across a job board": where the apply **form** comes from.
 *
 * The root and the two pins are picked per **host**, and *Save as default* widens that pick to the
 * host's whole **job board** (the registry's slug) - so Greenhouse's three hosts fill from one pick,
 * and Djinni's dashboard fills from what `/jobs` taught. A host that has been picked on keeps its own
 * recipe: a board default is a fallback, never an override.
 */
describe('the apply form a job board shares', () => {
  const BOARD_PICK = {
    root: { selector: '#application-form' },
    pins: { cover_letter: '#cover_letter_text', resume_file: '#resume' },
  };

  it("fills from this host's own pick before the board's default", async () => {
    const url = 'https://boards.greenhouse.io/acme/jobs/2';
    const { worker } = harness({
      page: url,
      storage: {
        formRecipes: { 'boards.greenhouse.io': { root: { selector: '#other-form' }, pins: {} } },
        formDefaults: { greenhouse: BOARD_PICK },
      },
    });

    const { recipe, source } = await worker.recipeFor(url);

    expect(source).toBe('host');
    expect(recipe.root.selector).toBe('#other-form');
  });

  it('fills a host nobody has picked on from the board default', async () => {
    // The case the feature is for: Greenhouse's other hosts, with no pick of their own.
    const { worker, calls } = harness({
      page: 'https://job-boards.greenhouse.io/acme/jobs/7',
      known: { '7': { jobId: 'job-7' } },
      storage: { formRecipes: {}, formDefaults: { greenhouse: BOARD_PICK } },
    });

    // It gets past "the form has not been picked on this site yet" without a pick on this host.
    const result = await worker.populate(1);

    expect(result.ok).toBe(true);
    expect(result.jobId).toBe('job-7');
    expect(calls.some((call) => call.path.startsWith('/api/apply/'))).toBe(true);
  });

  it("saves this host's pick as the whole board's default", async () => {
    // The harness's default state: `PAGE`'s host (`job-boards.eu.greenhouse.io`) holds a pick.
    const { worker, store } = harness({});

    const saved = await worker.saveFormDefaults(PAGE);

    expect(saved).toMatchObject({ ok: true, board: 'greenhouse' });
    const defaults = store.formDefaults as Record<string, { root: { selector: string } }>;
    expect(defaults.greenhouse.root.selector).toBe('#application-form');
    // ...and a sibling host resolves it without any pick of its own.
    expect((await worker.recipeFor('https://boards.greenhouse.io/acme/jobs/9')).source).toBe('board');
  });

  it('refuses to save a default when this host has nothing picked', async () => {
    const { worker } = harness({ storage: { formRecipes: {}, formDefaults: {} } });

    const saved = await worker.saveFormDefaults(PAGE);

    expect(saved).toEqual({ ok: false, error: expect.stringContaining('nothing picked') });
  });

  it('never shares a default between two unrelated unlisted hosts', async () => {
    // `other` is a single slug for every unknown site, so an unlisted host is its own board.
    const { worker, store } = harness({
      page: 'https://one.example.com/apply',
      storage: {
        formRecipes: { 'one.example.com': { root: { selector: '#form' }, pins: {} } },
        formDefaults: {},
      },
    });

    await worker.saveFormDefaults('https://one.example.com/apply');

    expect(Object.keys(store.formDefaults as object)).toEqual(['one.example.com']);
    expect((await worker.recipeFor('https://two.example.com/apply')).recipe).toBeNull();
  });

  it('forgets the host pick and the board default together', async () => {
    const { worker, store } = harness({});
    await worker.saveFormDefaults(PAGE);

    await worker.clearRecipe(PAGE);

    expect(await worker.recipeFor(PAGE)).toEqual({ recipe: null, source: '' });
    expect(store.formRecipes).toEqual({});
    expect(store.formDefaults).toEqual({});
  });
});
