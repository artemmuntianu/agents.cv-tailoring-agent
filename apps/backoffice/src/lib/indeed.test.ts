import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { indeed } from '../../../extension/src/sites/indeed.js';

/**
 * The per-card buttons for Indeed's feed are a **content script** - a classic script the browser
 * loads into the page - so this test runs it the way the browser does: `window.eval(source)` inside
 * a jsdom page, with a fake `chrome` runtime answering the two messages it sends.
 *
 * The fixture is the live feed (`indeed-feed.html`, saved from pt.indeed.com with its scripts and
 * styles stripped - which is what the scraper sees anyway): 12 cards on the left, and the one
 * description the right pane is showing. It pins the rule this shape exists for: a button must
 * never scrape whichever vacancy the pane happens to be showing when the card it was clicked for
 * is a different one.
 */
const SOURCE = readFileSync(
  fileURLToPath(new URL('../../../extension/src/indeed.js', import.meta.url)),
  'utf8',
);
const FEED = readFileSync(
  fileURLToPath(new URL('./fixtures/indeed-feed.html', import.meta.url)),
  'utf8',
);
const MANIFEST = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../extension/manifest.json', import.meta.url)), 'utf8'),
) as { content_scripts: { matches: string[]; js: string[] }[]; host_permissions: string[] };

/** The card the fixture's pane is showing. */
const PANE_JK = '1e8f8f14586c5ce3';

/** Chrome match pattern -> regex (`*` is the only wildcard; everything else is literal). */
function patternToRegex(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
}

interface Sent {
  type: string;
  externalIds?: string[];
  externalId?: string;
}

/** A `chrome.runtime.onMessage` listener: the worker asks, the page answers. */
type Listener = (message: Sent, sender?: unknown, respond?: (response: unknown) => void) => unknown;

type Answer = Record<string, unknown> | ((message: Sent) => Record<string, unknown>);

const NOT_SIGNED_IN = { ok: false, error: 'not signed in' };

/**
 * A page with the content script already evaluated in it.
 *
 * `deadlineMs` is the script's documented test hook (`data-cvt-indeed-deadline-ms`): the pane wait
 * is 3s in production, and a suite that really waited it out would take seconds per refusal test.
 */
function page(answers: Record<string, Answer> = {}, deadlineMs = 40) {
  const dom = new JSDOM(FEED, {
    url: 'https://pt.indeed.com/',
    runScripts: 'outside-only',
    // The script logs through `console.info`; jsdom's console would echo it into the test output.
    virtualConsole: new VirtualConsole(),
  });
  const sent: Sent[] = [];
  const listeners: Listener[] = [];
  if (deadlineMs > 0) {
    dom.window.document.documentElement.dataset.cvtIndeedDeadlineMs = String(deadlineMs);
  }
  (dom.window as unknown as { chrome: unknown }).chrome = {
    runtime: {
      id: 'test-extension',
      sendMessage: (message: Sent, callback: (response: unknown) => void) => {
        sent.push(message);
        const answer = answers[message.type];
        if (!answer) return callback(NOT_SIGNED_IN);
        callback(typeof answer === 'function' ? answer(message) : answer);
      },
      onMessage: { addListener: (listener: Listener) => listeners.push(listener) },
    },
  };

  dom.window.eval(SOURCE);
  return { dom, sent, listeners, document: dom.window.document };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const rescan = () => new Promise((resolve) => setTimeout(resolve, 350));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Past one poll interval (250ms), so a simulated pane swap has been seen. */
const paneSettled = () => wait(400);

/** The pane's description container - the string the script and `extract.js` must agree on. */
const DESCRIPTION_SELECTOR = '.simple-job-description-html';

const cardStatus = { ok: true, gateway: 'http://localhost:4321', known: {} };

function cards(document: Document): Element[] {
  return Array.from(document.querySelectorAll('div.cardOutline'));
}

function jkOf(card: Element): string {
  return card.querySelector('a[data-jk]')?.getAttribute('data-jk') || '';
}

/** The first card that is *not* the one the pane is showing - the interesting click. */
function otherCard(document: Document): Element {
  const found = cards(document).find((card) => jkOf(card) !== PANE_JK);
  if (!found) throw new Error('the fixture holds only the selected card');
  return found;
}

/**
 * What Indeed does when its own handler selects a card: the highlight moves, and the pane's own
 * links are re-rendered for the new job. The description HTML follows the *data* rather than
 * accompanying it, which is the lag the readiness rule exists for.
 */
function selectInPage(document: Document, card: Element, jk: string): void {
  for (const node of Array.from(document.querySelectorAll('.vjs-highlight'))) {
    node.classList.remove('vjs-highlight');
  }
  card.classList.add('vjs-highlight');
  for (const link of Array.from(document.querySelectorAll('a[href*="fromjk="]'))) {
    link.setAttribute(
      'href',
      String(link.getAttribute('href')).replace(/fromjk=[0-9a-f]+/i, `fromjk=${jk}`),
    );
  }
}

/**
 * Ask the content script something the way `background.js` does, and wait for the answer - including
 * an answer that only arrives once the pane has settled (`indeedSelect` returns `true` to stay open).
 */
function ask(listeners: Listener[], message: Sent): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    for (const listener of listeners) {
      listener(message, {}, (response) => resolve((response as Record<string, unknown>) || {}));
    }
  });
}

describe('per-card buttons on Indeed`s feed (content script)', () => {
  it('adds one Scrape button per card, on its own centred strip at the card`s bottom', () => {
    const { document, sent } = page({ cardStatus });

    const buttons = Array.from(document.querySelectorAll('button.cvt-scrape'));
    expect(buttons).toHaveLength(12);

    for (const button of buttons) {
      expect(button.textContent).toBe('Scrape');
      expect(button.getAttribute('data-cvt-state')).toBe('idle');

      // Its own strip: full width, centred - not the right end of Indeed's own icon row, which is where
      // `margin-left:auto` used to park it (operator request 2026-10-05).
      const row = button.parentElement as HTMLElement;
      expect(row.classList.contains('cvt-scrape-row')).toBe(true);
      expect(row.style.display).toBe('flex');
      expect(row.style.justifyContent).toBe('center');
      expect(row.style.width).toBe('100%');
      expect(row.children).toHaveLength(1);

      // The block that holds the site's own save / not-interested row - locale-independent, unlike the
      // labels on those buttons - and the strip is the last thing in it: the bottom of the card.
      const host = row.parentElement as HTMLElement;
      expect(host.querySelector('.ctaContainer')).not.toBeNull();
      expect(host.lastElementChild).toBe(row);
      expect(button.closest('.ctaContainer')).toBeNull();
    }

    // One lookup for the whole page, not one per card.
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('cardStatus');
    expect(sent[0].externalIds).toHaveLength(12);
  });

  it('selects the card and waits for the pane before asking the worker', async () => {
    const { document, sent } = page({
      cardStatus,
      scrapeCard: { ok: true, jobId: 'job-1', gateway: 'http://localhost:4321' },
    });
    const card = otherCard(document);
    const externalId = jkOf(card);

    (card.querySelector('button.cvt-scrape') as HTMLButtonElement).click();
    // The click asked the *page* to move, and has not asked the worker for anything: the pane still
    // shows another vacancy, and scraping that one would file the wrong job against this card.
    expect(sent.filter((message) => message.type === 'scrapeCard')).toHaveLength(0);

    selectInPage(document, card, externalId); // what Indeed's own handler does
    await paneSettled();

    expect(sent.filter((message) => message.type === 'scrapeCard')).toEqual([
      { type: 'scrapeCard', externalId: externalId },
    ]);
    const link = card.querySelector('a.cvt-scrape');
    expect(link?.textContent).toBe('Scraped');
    expect(link?.getAttribute('href')).toBe('http://localhost:4321/?card=job-1');
    expect(link?.getAttribute('data-cvt-state')).toBe('done');
  });

  it('refuses to guess when the pane never shows the card that was clicked', async () => {
    const { document, sent } = page({
      cardStatus,
      scrapeCard: { ok: true, jobId: 'job-wrong' },
    });
    const card = otherCard(document);

    (card.querySelector('button.cvt-scrape') as HTMLButtonElement).click();
    await paneSettled();

    // The wait is over and the pane is still showing someone else's vacancy: no scrape, no card.
    expect(sent.filter((message) => message.type === 'scrapeCard')).toHaveLength(0);
    const button = card.querySelector('button.cvt-scrape');
    expect(button?.getAttribute('data-cvt-state')).toBe('error');
    expect(button?.textContent).toBe('Retry scrape');
    expect(button?.getAttribute('title')).toContain('click the card');
  });

  it('waits for the description itself, not just for the selection', async () => {
    // The live failure (2026-10-05): Indeed moves the highlight and re-renders the pane's links
    // before it renders the text. A wait that watched only the selection handed the worker an empty
    // pane, which answered "that card is not on this page any more - reload and retry".
    const { document, sent } = page(
      { cardStatus, scrapeCard: { ok: true, jobId: 'job-slow', gateway: 'http://localhost:4321' } },
      1200,
    );
    const card = otherCard(document);
    const externalId = jkOf(card);

    // Hold back the text the pane is about to hold, so the selection can land without it.
    const description = document.querySelector(DESCRIPTION_SELECTOR) as Element;
    const parent = description.parentElement as Element;
    const next = description.nextSibling;
    description.remove();

    (card.querySelector('button.cvt-scrape') as HTMLButtonElement).click();
    selectInPage(document, card, externalId);
    await wait(300);

    // Selected, described nowhere: the worker is still not asked for anything.
    expect(sent.filter((message) => message.type === 'scrapeCard')).toHaveLength(0);

    parent.insertBefore(description, next);
    await wait(400);

    expect(sent.filter((message) => message.type === 'scrapeCard')).toEqual([
      { type: 'scrapeCard', externalId: externalId },
    ]);
  });

  it('treats a pane that still names another vacancy as not ready', async () => {
    // The guard behind "never a wrong scrape": the highlight lands on the clicked card, but the
    // pane's own links still name the previous job. Its `fromjk` is what decides, not the highlight.
    const { document, sent } = page(
      { cardStatus, scrapeCard: { ok: true, jobId: 'job-wrong' } },
      400,
    );
    const card = otherCard(document);

    (card.querySelector('button.cvt-scrape') as HTMLButtonElement).click();
    for (const node of Array.from(document.querySelectorAll('.vjs-highlight'))) {
      node.classList.remove('vjs-highlight');
    }
    card.classList.add('vjs-highlight'); // ...and the pane itself is never re-rendered
    await wait(900);

    expect(sent.filter((message) => message.type === 'scrapeCard')).toHaveLength(0);
    expect(card.querySelector('button.cvt-scrape')?.getAttribute('data-cvt-state')).toBe('error');
  });

  it('waits on the very container the site`s strategy reads, so the two cannot drift', () => {
    // The content script only *waits* for the description; the reader (`extract.js`) reads it into a
    // vacancy, and the selector itself now lives in the site's strategy. Asserting against the plan -
    // rather than grepping a source file - is what makes this a contract: change the strategy and this
    // fails, in the same run that the content script would start waiting for the wrong thing.
    expect(SOURCE).toContain(`'${DESCRIPTION_SELECTOR}'`);
    expect(indeed.plan.description).toContain(DESCRIPTION_SELECTOR);
  });

  it('never asks for a card the board already has, even when clicked', async () => {
    const { document, sent } = page({
      cardStatus: {
        ok: true,
        gateway: 'http://localhost:4321',
        known: { [PANE_JK]: { jobId: 'job-known', status: 'submitted', archived: false } },
      },
    });
    await settle();

    const link = document.querySelector('a.cvt-scrape') as HTMLAnchorElement;
    expect(link?.textContent).toBe('Scraped');
    expect(link?.getAttribute('href')).toBe('http://localhost:4321/?card=job-known');
    link.click();
    await settle();

    expect(sent.filter((message) => message.type === 'scrapeCard')).toHaveLength(0);
  });

  it('re-injects after the feed re-renders a card in place', async () => {
    const { document } = page({ cardStatus });
    const card = cards(document)[0];
    const replacement = card.cloneNode(true) as Element;
    for (const node of Array.from(replacement.querySelectorAll('.cvt-scrape'))) node.remove();
    card.replaceWith(replacement);
    expect(document.querySelectorAll('button.cvt-scrape')).toHaveLength(11);

    await rescan();
    expect(document.querySelectorAll('button.cvt-scrape')).toHaveLength(12);
  });

  it('hands a sweep the page`s cards, in the order the feed renders them', async () => {
    const { listeners } = page({ cardStatus });

    const answer = await ask(listeners, { type: 'indeedCards' });

    expect(answer.ok).toBe(true);
    expect(answer.ids).toHaveLength(12);
    expect((answer.ids as string[])[0]).toBe(PANE_JK);
  });

  it('selects the card a sweep asks for, and answers only once its pane is readable', async () => {
    const { document, listeners } = page({ cardStatus });
    const card = otherCard(document);
    const externalId = jkOf(card);

    let answered = false;
    const answer = ask(listeners, { type: 'indeedSelect', externalId: externalId }).then(
      (response) => {
        answered = true;
        return response;
      },
    );
    await wait(20);
    // Still unanswered: the pane is describing the previous vacancy, and the sweep must not read it.
    expect(answered).toBe(false);

    selectInPage(document, card, externalId);
    expect(await answer).toEqual({ ok: true, ready: true });
  });

  it('tells a sweep the truth when the pane never becomes readable', async () => {
    const { document, listeners } = page({ cardStatus }, 40);
    const card = otherCard(document);

    expect(await ask(listeners, { type: 'indeedSelect', externalId: jkOf(card) })).toEqual({
      ok: true,
      ready: false,
    });
  });

  it('selects a card without letting the page open the vacancy', async () => {
    // The other half of the 2026-10-05 bug ("the autoscraper opens vacancies"): Indeed's own handler is
    // what swaps the pane, and it is also free to open the posting - right for a human's click, and a
    // tab per card for a sweep. Both guards are pinned here.
    const { document, sent } = page({
      cardStatus,
      scrapeCard: { ok: true, jobId: 'job-guarded', gateway: 'http://localhost:4321' },
    });
    const card = otherCard(document);
    const externalId = jkOf(card);
    const link = card.querySelector('a[data-jk]') as HTMLAnchorElement;

    const opened: string[] = [];
    const win = document.defaultView as unknown as { open: (url?: string) => unknown };
    const realOpen = win.open;
    win.open = (url?: string) => {
      opened.push(String(url));
      return null;
    };
    const seen: MouseEvent[] = [];
    link.addEventListener('click', (event) => seen.push(event as MouseEvent));

    (card.querySelector('button.cvt-scrape') as HTMLButtonElement).click();
    selectInPage(document, card, externalId);
    await paneSettled();

    // The handler ran (so the pane can swap) ...
    expect(seen).toHaveLength(1);
    // ... but the anchor's own `href`/`target` could not act on the click ...
    expect(seen[0].defaultPrevented).toBe(true);
    // ... and neither could the handler's own `window.open`.
    expect(opened).toEqual([]);
    win.open = realOpen;

    expect(sent.filter((message) => message.type === 'scrapeCard')).toHaveLength(1);
  });

  it('is declared for Indeed, and granted the host it injects into', () => {
    const files = MANIFEST.content_scripts.flatMap((entry) => entry.js);
    expect(files).toContain('src/indeed.js');

    const patterns = MANIFEST.content_scripts.flatMap((entry) => entry.matches).map(patternToRegex);
    for (const url of ['https://pt.indeed.com/', 'https://pt.indeed.com/viewjob?jk=1']) {
      expect(patterns.some((pattern) => pattern.test(url)), url).toBe(true);
    }
    // ...and nowhere else.
    expect(patterns.some((pattern) => pattern.test('https://example.com/jobs/'))).toBe(false);

    // `activeTab` covers only the popup path; a content script's `matches` grants no permission,
    // and `scrapeCard` injects `extractVacancies` with `chrome.scripting`.
    const granted = MANIFEST.host_permissions.map(patternToRegex);
    expect(granted.some((pattern) => pattern.test('https://pt.indeed.com/'))).toBe(true);
  });

});
