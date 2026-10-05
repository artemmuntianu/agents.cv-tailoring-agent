import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { BATCH_SIZE, createSweepWorker } from '../../../extension/src/indeed/sweep.js';

/**
 * The Indeed page sweep (`apps/extension/src/indeed/sweep.js`) runs on `chrome.tabs`/`chrome.scripting`
 * rather than on the DOM, so it is faked here instead of rendered - the way the form filler's worker
 * half already is (`form-worker.test.ts`).
 *
 * The promise worth pinning is the walk's: **every card it queues is the card whose pane was readable
 * at that moment.** The fake models the real coupling - the page shows whichever vacancy the content
 * script last selected - so a card whose pane never settles cannot be filed under the previous
 * vacancy's text; it is skipped instead.
 */

const TAB = 7;
const TAB_URL = 'https://pt.indeed.com/';

interface Harness {
  published: string[][];
  selected: string[];
  worker: ReturnType<typeof createSweepWorker>;
}

function harness(
  options: { ids?: string[]; stuck?: string[]; failAt?: number; known?: string[] } = {},
): Harness {
  const published: string[][] = [];
  const selected: string[] = [];
  let pane = ''; // the vacancy the page is currently showing
  let batches = 0;
  const globals = globalThis as unknown as Record<string, unknown>;

  globals.chrome = {
    runtime: { lastError: null },
    tabs: {
      sendMessage: (
        _tabId: number,
        message: { type: string; externalId?: string },
        callback: (response: unknown) => void,
      ) => {
        if (message.type === 'indeedCards') return callback({ ok: true, ids: options.ids ?? [] });
        if (message.type === 'indeedSelect') {
          const ready = !(options.stuck ?? []).includes(String(message.externalId));
          if (ready) {
            pane = String(message.externalId);
            selected.push(pane);
          }
          return callback({ ok: true, ready: ready });
        }
        return callback({ ok: false });
      },
    },
    scripting: {
      // The worker injects `extractVacancies`; what matters here is *that it reads the pane*, so the
      // fake answers with whichever vacancy the page happens to be showing.
      executeScript: async () => [{ result: { vacancies: pane ? [{ external_id: pane }] : [] } }],
    },
  };

  const publish = async (payload: { vacancies: { external_id: string }[] }) => {
    batches += 1;
    if (options.failAt === batches) return { ok: false, error: 'gateway said no' };
    published.push(payload.vacancies.map((vacancy) => vacancy.external_id));
    return { ok: true, created: payload.vacancies.length, duplicates: 0 };
  };

  return {
    published,
    selected,
    worker: createSweepWorker({
      publish,
      settleMs: 0,
      // The board's answer, injected - production reads it from `GET /api/vacancies/status`.
      knownIds: async () => new Set(options.known ?? []),
    }),
  };
}

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).chrome;
});

describe('sweeping an Indeed feed', () => {
  it('walks every card in order, reads each one, and publishes them as one batch', async () => {
    const h = harness({ ids: ['a', 'b', 'c'] });
    const result = await h.worker.run(TAB, TAB_URL);

    expect(h.selected).toEqual(['a', 'b', 'c']);
    expect(h.published).toEqual([['a', 'b', 'c']]);
    expect(result).toMatchObject({ ok: true, created: 3, skipped: 0 });
    expect(h.worker.progress()).toMatchObject({ running: false, done: 3, total: 3, created: 3 });
  });

  it('skips a card whose pane never became readable, never filing the previous one', async () => {
    const h = harness({ ids: ['a', 'b', 'c'], stuck: ['b'] });
    const result = await h.worker.run(TAB, TAB_URL);

    // `b` never moved the pane, so the reader still answered `a`: queueing that would have put one
    // vacancy's description under another vacancy's id.
    expect(h.published).toEqual([['a', 'c']]);
    expect(result).toMatchObject({ ok: true, created: 2, skipped: 1 });
  });

  it('chunks a long feed at the endpoint`s own cap', async () => {
    const ids = Array.from({ length: BATCH_SIZE + 3 }, (_, i) => `j${i}`);
    const h = harness({ ids });
    const result = await h.worker.run(TAB, TAB_URL);

    expect(h.published.map((batch) => batch.length)).toEqual([BATCH_SIZE, 3]);
    expect(result).toMatchObject({ ok: true, created: BATCH_SIZE + 3, duplicates: 0, skipped: 0 });
  });

  it('agrees with the gateway about that cap', () => {
    // One number, two files: the batch route rejects the 26th card, so drift here breaks the sweep.
    const source = readFileSync(fileURLToPath(new URL('./vacancies.ts', import.meta.url)), 'utf8');
    expect(/export const MAX_BATCH_SIZE = (\d+)/.exec(source)?.[1]).toBe(String(BATCH_SIZE));
  });

  it('reports a page with no cards as an error, and publishes nothing', async () => {
    const h = harness({ ids: [] });
    const result = await h.worker.run(TAB, TAB_URL);

    expect(result.ok).toBe(false);
    expect(h.published).toEqual([]);
  });

  it('stops at the first refused batch, and still reports the cards that landed', async () => {
    const ids = Array.from({ length: BATCH_SIZE + 2 }, (_, i) => `k${i}`);
    const h = harness({ ids, failAt: 2 });
    const result = await h.worker.run(TAB, TAB_URL);

    expect(result.ok).toBe(false);
    expect(result.created).toBe(BATCH_SIZE);
    expect(h.published).toHaveLength(1);
  });

  it('leaves alone the cards the board already has', async () => {
    // The bug this pins (live 2026-10-05): the walk selected every card, so the feed flickered through
    // vacancies whose buttons already said `Scraped`, and re-published them as duplicates.
    const h = harness({ ids: ['a', 'b', 'c'], known: ['a', 'c'] });

    const result = await h.worker.run(TAB, TAB_URL);

    expect(h.selected).toEqual(['b']);
    expect(h.published).toEqual([['b']]);
    expect(result).toMatchObject({ ok: true, created: 1, already: 2 });
  });

  it('calls a page that is entirely on the board a success, not a failure', async () => {
    const h = harness({ ids: ['a', 'b'], known: ['a', 'b'] });

    const result = await h.worker.run(TAB, TAB_URL);

    expect(result).toEqual({ ok: true, created: 0, duplicates: 0, skipped: 0, already: 2 });
    expect(h.selected).toEqual([]);
    expect(h.published).toEqual([]);
    expect(h.worker.progress().running).toBe(false);
  });

  it('walks every card when the board knows none of them', async () => {
    const h = harness({ ids: ['a', 'b'] });

    const result = await h.worker.run(TAB, TAB_URL);

    expect(h.selected).toEqual(['a', 'b']);
    expect(result).toMatchObject({ ok: true, created: 2, already: 0 });
  });

  it('refuses a second walk while one is running, and clears the flag when it ends', async () => {
    const h = harness({ ids: ['a', 'b'] });

    const first = h.worker.run(TAB, TAB_URL);
    expect(await h.worker.run(TAB, TAB_URL)).toEqual({
      ok: false,
      error: 'a sweep is already running',
    });
    await first;
    expect(h.worker.progress().running).toBe(false);
  });

  it('clears the flag even when the walk fails, so the next press is not refused', async () => {
    const h = harness({ ids: [] });

    await h.worker.run(TAB, TAB_URL);
    expect(h.worker.progress().running).toBe(false);

    const second = await h.worker.run(TAB, TAB_URL);
    expect(second.error).toBe('no Indeed cards on this page');
  });
});
