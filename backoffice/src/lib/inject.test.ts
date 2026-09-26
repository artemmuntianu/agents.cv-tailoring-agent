import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { describe, expect, it } from 'vitest';

/**
 * The injected per-card buttons are a **content script** - a classic script the browser loads
 * into the page - so this test runs it the way the browser does: `window.eval(source)` inside
 * a jsdom page, with a fake `chrome` runtime answering the two messages it sends
 * (`cardStatus`, `scrapeCard`).
 *
 * Fixture: `fixtures/djinni-card-footer.html`, a copy of the live card markup (including the
 * `data-job-id` hook on the site's own copy-link button, which is what the script keys on).
 */
const SOURCE = readFileSync(
  fileURLToPath(new URL('../../../extension/src/inject.js', import.meta.url)),
  'utf8',
);
const CARDS = readFileSync(
  fileURLToPath(new URL('./fixtures/djinni-card-footer.html', import.meta.url)),
  'utf8',
);
const MANIFEST = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../extension/manifest.json', import.meta.url)), 'utf8'),
) as { content_scripts: { matches: string[]; js: string[] }[]; host_permissions: string[] };

/** Chrome match pattern -> regex (`*` is the only wildcard; everything else is literal). */
function patternToRegex(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
}

interface Sent {
  type: string;
  externalIds?: string[];
  externalId?: string;
}

type Answer = Record<string, unknown> | ((message: Sent) => Record<string, unknown>);

const NOT_SIGNED_IN = { ok: false, error: 'not signed in' };

/** A page with the content script already evaluated in it. */
function page(html: string, answers: Record<string, Answer> = {}) {
  const dom = new JSDOM(`<body>${html}</body>`, {
    url: 'https://djinni.co/jobs/?primary_keyword=Python',
    runScripts: 'outside-only',
    // The script logs through `console.info`; jsdom's default console would echo it into the
    // test output.
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const rescan = () => new Promise((resolve) => setTimeout(resolve, 350));

describe('per-card buttons (content script)', () => {
  it('adds one green Scrape button per card, as the last item of the footer action row', () => {
    const { document, sent } = page(CARDS, { cardStatus: { ok: true, known: {} } });

    const buttons = Array.from(document.querySelectorAll('button.cvt-scrape'));
    expect(buttons).toHaveLength(2);

    for (const button of buttons) {
      expect(button.textContent).toBe('Scrape');
      expect(button.classList.contains('btn-success')).toBe(true);
      expect(button.getAttribute('data-cvt-state')).toBe('idle');
      // The footer's right bottom corner: pushed right, and the row's last child.
      expect(button.getAttribute('style')).toContain('margin-left: auto');
      expect(button.parentElement?.lastElementChild).toBe(button);
      // ...and it sits in the row the site's own actions (copy link) live in.
      expect(button.parentElement?.querySelector('.copy-link-item')).not.toBeNull();
    }

    // One lookup for the whole page, not one per card.
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('cardStatus');
    expect(sent[0].externalIds?.sort()).toEqual(['850359', '850374']);
  });

  it('is a link to the vacancy card for a vacancy the board already has', async () => {
    const { document } = page(CARDS, {
      cardStatus: {
        ok: true,
        gateway: 'http://localhost:4321',
        known: { '850374': { jobId: 'job-850374', status: 'completed', archived: false } },
      },
    });
    await settle(); // the lookup answer arrives after the first paint

    const link = document.querySelector('#job-item-850374 a.cvt-scrape');
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe('Scraped');
    expect(link?.getAttribute('href')).toBe('http://localhost:4321/?card=job-850374');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('data-cvt-state')).toBe('done');
    expect(link?.getAttribute('title')).toContain('tailored');
    expect(link?.getAttribute('style')).toContain('margin-left: auto');

    // The vacancy the board has never seen keeps its button.
    expect(document.querySelector('#job-item-850359 button.cvt-scrape')).not.toBeNull();
  });

  it('scrapes on click, then turns into the card link', async () => {
    const { document, sent } = page(CARDS, {
      cardStatus: { ok: true, gateway: 'http://localhost:4321', known: {} },
      scrapeCard: {
        ok: true,
        jobId: 'job-new',
        gateway: 'http://localhost:4321',
        published: 1,
        duplicates: 0,
      },
    });

    const button = document.querySelector('#job-item-850374 button.cvt-scrape') as HTMLButtonElement;
    button.click();
    expect(button.getAttribute('data-cvt-state')).toBe('busy');
    expect(button.disabled).toBe(true);
    await settle();

    // The content script never builds a vacancy payload: the worker extracts it, so there is
    // one copy of the DOM contract (`extract.js`) and not two.
    expect(sent[1]).toEqual({ type: 'scrapeCard', externalId: '850374' });

    const link = document.querySelector('#job-item-850374 a.cvt-scrape');
    expect(link?.textContent).toBe('Scraped');
    expect(link?.getAttribute('href')).toBe('http://localhost:4321/?card=job-new');
    expect(link?.getAttribute('title')).toContain('tailoring in progress');
  });

  it('does not re-scrape a card it already knows, even when clicked', async () => {
    const { document, sent } = page(CARDS, {
      cardStatus: {
        ok: true,
        gateway: 'http://localhost:4321',
        known: { '850374': { jobId: 'job-850374', status: 'submitted', archived: false } },
      },
    });
    await settle();

    const link = document.querySelector('#job-item-850374 a.cvt-scrape') as HTMLAnchorElement;
    link.click();
    await settle();

    expect(sent.filter((message) => message.type === 'scrapeCard')).toHaveLength(0);
    expect(document.querySelector('#job-item-850374 a.cvt-scrape')?.textContent).toBe('Scraped');
  });

  it('offers a retry, with the reason, when the scrape fails', async () => {
    const { document } = page(CARDS, {
      cardStatus: { ok: true, gateway: 'http://localhost:4321', known: {} },
      scrapeCard: { ok: false, error: 'that card is not on this page any more - reload and retry' },
    });

    (document.querySelector('#job-item-850374 button.cvt-scrape') as HTMLButtonElement).click();
    await settle();

    const button = document.querySelector('#job-item-850374 button.cvt-scrape');
    expect(button?.textContent).toBe('Retry scrape');
    expect(button?.getAttribute('data-cvt-state')).toBe('error');
    expect(button?.getAttribute('title')).toContain('not on this page any more');
  });

  it('keeps the buttons as Scrape while the extension is not signed in', () => {
    const { document } = page(CARDS);
    const button = document.querySelector('#job-item-850374 button.cvt-scrape');
    expect(button?.getAttribute('data-cvt-state')).toBe('idle');
    expect(button?.textContent).toBe('Scrape');
  });

  it('re-injects after the site swaps a card in place (htmx)', async () => {
    const { document } = page(CARDS, { cardStatus: { ok: true, known: {} } });
    const card = document.querySelector('#job-item-850374') as Element;

    // What `hx-swap="outerHTML"` does: the node is replaced, so our button goes with it (the
    // clone here stands in for the server's fresh fragment, which of course has no button).
    const replacement = card.cloneNode(true) as Element;
    for (const node of Array.from(replacement.querySelectorAll('.cvt-scrape'))) node.remove();
    card.replaceWith(replacement);
    expect(document.querySelector('#job-item-850374 button.cvt-scrape')).toBeNull();

    await rescan();
    const button = document.querySelector('#job-item-850374 button.cvt-scrape');
    expect(button?.textContent).toBe('Scrape');
    expect(button?.parentElement?.querySelector('.copy-link-item')).not.toBeNull();
  });

  it('follows the popup: a batch scrape flips the buttons the worker already had', async () => {
    // The first lookup knows nothing; after the popup publishes, the board does.
    let round = 0;
    const { document, listeners } = page(CARDS, {
      cardStatus: () => {
        round += 1;
        return round === 1
          ? { ok: true, gateway: 'http://localhost:4321', known: {} }
          : {
              ok: true,
              gateway: 'http://localhost:4321',
              known: { '850359': { jobId: 'job-batch', status: 'submitted', archived: false } },
            };
      },
    });
    await settle();
    expect(document.querySelector('#job-item-850359 button.cvt-scrape')).not.toBeNull();

    // What `background.js` sends to every tab after a `publish` with `published > 0`.
    for (const listener of listeners) listener({ type: 'boardChanged' });
    await settle();

    const link = document.querySelector('#job-item-850359 a.cvt-scrape');
    expect(link?.textContent).toBe('Scraped');
    expect(link?.getAttribute('href')).toBe('http://localhost:4321/?card=job-batch');
    // The other vacancy is still not on the board.
    expect(document.querySelector('#job-item-850374 button.cvt-scrape')).not.toBeNull();
  });

  it('prefers the copy-link hook, so a stray data-job-id elsewhere cannot move the button', () => {
    // The card with `data-job-id` also on a non-action element *earlier* in the DOM: the button
    // must still land in the real action row, not next to the decoy.
    const fresh = page(CARDS.replace('<h2', '<span data-job-id="850374"></span><h2'), {
      cardStatus: { ok: true, known: {} },
    });
    const button = fresh.document.querySelector('#job-item-850374 button.cvt-scrape');
    expect(button?.parentElement?.querySelector('.copy-link-item')).not.toBeNull();
    expect(button?.parentElement?.lastElementChild).toBe(button);
  });

  it('declares the injector this suite tests', () => {
    const files = MANIFEST.content_scripts.flatMap((entry) => entry.js);
    expect(files).toContain('src/inject.js');
  });

  it('is injected wherever Djinni renders a card, not just the /jobs list', () => {
    // Where this was first missed: the dashboard/subscriptions page renders the same cards.
    const patterns = MANIFEST.content_scripts
      .flatMap((entry) => entry.matches)
      .map(patternToRegex);

    for (const url of [
      'https://djinni.co/jobs/',
      'https://djinni.co/jobs/850374-founding-engineer/?ref=shared',
      'https://djinni.co/my/dashboard/subs',
      'https://djinni.co/my/dashboard/subs/',
    ]) {
      expect(patterns.some((pattern) => pattern.test(url)), url).toBe(true);
    }

    // ...and nowhere else: no other host gets our buttons.
    expect(patterns.some((pattern) => pattern.test('https://example.com/jobs/'))).toBe(false);
    expect(patterns.some((pattern) => pattern.test('https://notdjinni.co/jobs/'))).toBe(false);
  });

  it('grants the card host as a permission too (`scrapeCard` injects with chrome.scripting)', () => {
    // Pressing a button on the page calls `scrapeCard`, which injects `extractVacancies` into
    // that tab with `chrome.scripting.executeScript`. That needs a *host permission*:
    // `activeTab` only covers the popup path (granted by clicking the toolbar icon), and a
    // content script's `matches` does not grant it. Missing this produced
    // "Cannot access contents of the page..." live (2026-09-26).
    const granted = MANIFEST.host_permissions.map(patternToRegex);
    for (const url of [
      'https://djinni.co/my/dashboard/subs',
      'https://djinni.co/jobs/850374-founding-engineer/',
    ]) {
      expect(granted.some((pattern) => pattern.test(url)), url).toBe(true);
    }
    // The gateway has to stay reachable as well.
    expect(
      granted.some((pattern) => pattern.test('http://localhost:4321/api/vacancies/status')),
    ).toBe(true);
  });

  it('updates every copy of the same vacancy (a dashboard can list one twice)', async () => {
    // The same card twice, as a subscriptions dashboard grouped by search would render it.
    const firstCard = CARDS.slice(
      CARDS.indexOf('<div id="job-item-850374"'),
      CARDS.indexOf('<div id="job-item-850359"'),
    );
    const { document } = page(CARDS + firstCard, {
      cardStatus: { ok: true, gateway: 'http://localhost:4321', known: {} },
      scrapeCard: { ok: true, jobId: 'job-new', gateway: 'http://localhost:4321', published: 1 },
    });
    await settle();

    const buttons = Array.from(document.querySelectorAll('button.cvt-scrape'));
    expect(buttons).toHaveLength(3); // 850374 twice, 850359 once
    (buttons[0] as HTMLButtonElement).click();
    await settle();

    const links = Array.from(document.querySelectorAll('a.cvt-scrape')).filter((link) =>
      (link.getAttribute('href') || '').endsWith('job-new'),
    );
    expect(links).toHaveLength(2);
  });

  it('explains a missing host permission instead of pasting the raw Chrome error', async () => {
    const { document } = page(CARDS, {
      cardStatus: { ok: true, gateway: 'http://localhost:4321', known: {} },
      scrapeCard: {
        ok: false,
        error:
          'Cannot access contents of the page. Extension manifest must request permission to access the respective host.',
      },
    });

    (document.querySelector('#job-item-850374 button.cvt-scrape') as HTMLButtonElement).click();
    await settle();

    const title = document.querySelector('#job-item-850374 button.cvt-scrape')?.getAttribute('title');
    expect(title).toContain('reload the extension');
    expect(title).not.toContain('must request permission');
  });

  it('falls back to the footer block when the data-job-id hook is gone', () => {
    const html = `
      <div id="job-item-1" class="job-item">
        <h2 class="job-item__position">Platform Engineer</h2>
        <span class="small text-gray-800">Co</span>
        <div class="d-flex flex-column gap-1">
          <div class="d-flex align-items-center gap-1 fs-5">12 переглядів</div>
          <div class="d-flex align-items-center gap-3">Зберегти</div>
        </div>
      </div>`;
    const { document } = page(html, { cardStatus: { ok: true, known: {} } });

    const button = document.querySelector('#job-item-1 button.cvt-scrape');
    expect(button).not.toBeNull();
    expect(button?.parentElement?.className).toContain('align-items-center');
    expect(button?.parentElement?.lastElementChild).toBe(button);
  });
});
