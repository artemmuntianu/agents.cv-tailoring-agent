import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { siteForSlug } from '../../../extension/src/sites/index.js';

/**
 * The MyGreenhouse portal's badges are a **content script** - a classic script the browser loads into
 * the page - so this test runs it the way the browser does: `window.eval(source)` inside a jsdom page
 * with a fake `chrome` runtime answering the one message it sends (`cardStatus`).
 *
 * Fixture: an inline tile snippet, written to the contract `apps/extension/AGENTS.md` records (a
 * `div[data-provides="search-result"]` tile, the job link inside it, the site's own bottom-right bell
 * button). The portal renders its tiles with Inertia, so there is no readable markup for CI to copy -
 * what matters is the tile shape the script keys on, and that is what this pins.
 *
 * Two things here are not visible in the script's own text, and both are the reason it exists:
 *
 * * the badge asks about the `greenhouse` source **explicitly**, because the portal's host is not a
 *   host the registry claims - a host-derived slug would be `other` and every badge would be grey;
 * * rendering a badge mutates the tile, which is itself a DOM change, so the script must not answer
 *   its own mutation with a second round of status requests.
 */
const SOURCE = readFileSync(
  fileURLToPath(new URL('../../../extension/src/mygreenhouse.js', import.meta.url)),
  'utf8',
);
const MANIFEST = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../extension/manifest.json', import.meta.url)), 'utf8'),
) as { content_scripts: { matches: string[]; js: string[] }[]; host_permissions: string[] };

/** Two tiles, as the portal renders them: the job link first, the site's own bell button last. */
const TILES = `
  <div class="relative rounded-lg border" data-provides="search-result">
    <a class="block" href="/jobs/cresteo/4740438005">Senior Software Engineer</a>
    <span class="absolute right-6 top-5" aria-hidden="true">bell</span>
  </div>
  <div class="relative rounded-lg border" data-provides="search-result">
    <a class="block" href="/jobs/cresteo/4663312008">Platform Engineer</a>
    <span class="absolute right-6 top-5" aria-hidden="true">bell</span>
  </div>`;

/** The one tile a later list leaves behind (a filter or a page change). */
const NEW_TILE = `
  <div class="relative rounded-lg border" data-provides="search-result">
    <a href="/jobs/cresteo/4551122334">Data Engineer</a>
  </div>`;

interface Sent {
  type: string;
  externalIds?: string[];
  source?: string;
}

type Answer = Record<string, unknown> | ((message: Sent) => Record<string, unknown>);

const NOT_SIGNED_IN = { ok: false, error: 'not signed in' };
const ANSWER_EMPTY = { ok: true, gateway: 'http://localhost:4321', known: {} };

/** A page with the badge script already evaluated in it. */
function page(html: string, answers: Record<string, Answer> = {}) {
  const dom = new JSDOM(`<body>${html}</body>`, {
    url: 'https://my.greenhouse.io/jobs/search?query=engineer',
    runScripts: 'outside-only',
    // The script logs through `console.info`; jsdom's default console would echo it into the output.
    virtualConsole: new VirtualConsole(),
  });
  const sent: Sent[] = [];
  const listeners: Array<(message: Sent) => void> = [];
  (dom.window as unknown as { chrome: unknown }).chrome = {
    runtime: {
      id: 'test-extension',
      sendMessage: (message: Sent, callback: (response: unknown) => void) => {
        sent.push(message);
        const answer = answers[message.type];
        if (!answer) return callback(NOT_SIGNED_IN);
        callback(typeof answer === 'function' ? answer(message) : answer);
      },
      onMessage: { addListener: (listener: (message: Sent) => void) => listeners.push(listener) },
    },
  };

  dom.window.eval(SOURCE);
  return { dom, sent, listeners, document: dom.window.document };
}

/** Longer than the script's 250 ms debounce, so a scan has run and its answer has rendered. */
const scanned = () => new Promise((resolve) => setTimeout(resolve, 400));
/** Long enough for the debounced re-scan the badge's own mutation schedules. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 700));

/** Every badge's text, in document order. */
const badges = (document: Document) =>
  Array.from(document.querySelectorAll('[data-cvt-badge]')).map((badge) => badge.textContent);

describe('MyGreenhouse portal badges (content script)', () => {
  it('stamps every tile Not Scraped at load', async () => {
    const { document, sent } = page(TILES, { cardStatus: ANSWER_EMPTY });
    await scanned();

    expect(badges(document)).toEqual(['Not Scraped', 'Not Scraped']);
    // The ids came from the tiles' own links: /jobs/<board>/<numeric-id>.
    expect(sent[0]?.externalIds).toEqual(['4740438005', '4663312008']);
  });

  it('says Scraped for a vacancy the board already has, and Not Scraped for its neighbour', async () => {
    const { document } = page(TILES, {
      cardStatus: {
        ok: true,
        known: { '4740438005': { jobId: 'job-1', status: 'completed', archived: false } },
      },
    });
    await scanned();

    const found = Array.from(document.querySelectorAll('[data-cvt-badge]'));
    expect(found[0]?.textContent).toBe('Scraped');
    expect(found[0]?.className).toContain('cvt-gh-badge--scraped');
    expect(found[1]?.textContent).toBe('Not Scraped');
    expect(found[1]?.className).toContain('cvt-gh-badge--not-scraped');
  });

  it('asks the board once for the page, about the source its vacancies are stored under', async () => {
    const { sent } = page(TILES, { cardStatus: ANSWER_EMPTY });
    await settled();

    // One request for the whole page - not one per tile - and still no second round after the badges
    // were rendered, although that rendering is itself a DOM mutation.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe('cardStatus');
    expect(sent[0]?.externalIds).toEqual(['4740438005', '4663312008']);

    // The portal's own host is not a host the registry claims, so the source has to be named - and a
    // name the registry does not know would make every lookup miss silently.
    expect(sent[0]?.source).toBe('greenhouse');
    expect(siteForSlug(String(sent[0]?.source))?.slug).toBe('greenhouse');
  });

  it('still badges a page nobody is signed in for, instead of staying blank', async () => {
    const { document } = page(TILES); // no answers: the fake runtime refuses, like an empty session
    await scanned();

    expect(badges(document)).toEqual(['Not Scraped', 'Not Scraped']);
  });

  it('re-reads the board when the popup queues a batch (boardChanged)', async () => {
    let known: Record<string, unknown> = {};
    const { document, listeners } = page(TILES, {
      cardStatus: () => ({ ok: true, gateway: 'http://localhost:4321', known }),
    });
    await scanned();
    expect(badges(document)).toEqual(['Not Scraped', 'Not Scraped']);

    known = { '4740438005': { jobId: 'job-1', status: 'submitted', archived: false } };
    expect(listeners).toHaveLength(1);
    for (const listener of listeners) listener({ type: 'boardChanged' });
    await scanned();

    expect(badges(document)).toEqual(['Scraped', 'Not Scraped']);
  });

  it('re-badges the tiles after Inertia swaps the list in place', async () => {
    const { document, sent } = page(`<div id="list">${TILES}</div>`, { cardStatus: ANSWER_EMPTY });
    await scanned();
    expect(badges(document)).toHaveLength(2);

    // A filter or a page change replaces the list; only the new tile is left on the page.
    document.getElementById('list')!.innerHTML = NEW_TILE;
    await scanned();

    expect(badges(document)).toEqual(['Not Scraped']);
    expect(sent[1]?.externalIds).toEqual(['4551122334']);
  });

  it('reads the job link even when the tile leads with the company link', async () => {
    const { document, sent } = page(
      `<div class="relative" data-provides="search-result">
         <a href="/companies/cresteo">cresteo</a>
         <a href="/jobs/cresteo/4740438005">Senior Software Engineer</a>
       </div>`,
      { cardStatus: { ok: true, known: { '4740438005': { jobId: 'job-1' } } } },
    );
    await scanned();

    expect(document.querySelector('[data-cvt-badge]')?.textContent).toBe('Scraped');
    expect(sent[0]?.externalIds).toEqual(['4740438005']);
  });

  it('leaves a tile whose link names no job alone, and asks nothing about it', async () => {
    const { document, sent } = page(
      '<div class="relative" data-provides="search-result"><a href="/saved">Saved jobs</a></div>',
      { cardStatus: ANSWER_EMPTY },
    );
    await scanned();

    expect(document.querySelector('[data-cvt-badge]')).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('never offers a scrape from the portal - what it adds is a status display', async () => {
    const { document, sent } = page(TILES, { cardStatus: ANSWER_EMPTY });
    await scanned();

    // The tile's markup is not the vacancy, so there is nothing here to scrape: the operator clicks
    // through to the board, where the per-card button lives.
    expect(document.querySelectorAll('button, a.cvt-scrape')).toHaveLength(0);
    expect(sent.every((message) => message.type === 'cardStatus')).toBe(true);
  });

  it('declares the badge script as its own content-script entry', () => {
    const own = MANIFEST.content_scripts.filter((entry) =>
      entry.js.includes('src/mygreenhouse.js'),
    );
    expect(own).toHaveLength(1);
    expect(own[0]?.matches).toEqual(['https://my.greenhouse.io/*']);
    expect(own[0]?.js).toEqual(['src/mygreenhouse.js']);

    // Its own entry, not the scraping/filling one: the portal renders no cards and no form, so
    // injecting those scripts there would be an observer watching for markup that never appears.
    const scrapers = MANIFEST.content_scripts.filter((entry) => entry.js.includes('src/inject.js'));
    for (const entry of scrapers) {
      expect(entry.matches).not.toContain('https://my.greenhouse.io/*');
    }
  });

  it('grants the portal as a host permission too', () => {
    expect(MANIFEST.host_permissions).toContain('https://my.greenhouse.io/*');
  });
});
