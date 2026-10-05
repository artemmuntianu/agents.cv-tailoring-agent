import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { extractVacancies } from '../../../extension/src/extract.js';
import { djinni } from '../../../extension/src/sites/djinni.js';
import { greenhouse } from '../../../extension/src/sites/greenhouse.js';
import { indeed } from '../../../extension/src/sites/indeed.js';
import { GENERIC } from '../../../extension/src/sites/index.js';

/**
 * The extension has no build step and no test runner of its own; its scraper is the
 * one piece of real logic, and it produces exactly the payload this project's batch
 * endpoint accepts - so it is tested here, against the DOM sample from the design
 * document, with jsdom.
 */
const CARD_HTML = readFileSync(
  fileURLToPath(new URL('./fixtures/djinni-listing.html', import.meta.url)),
  'utf8',
);
/** A board that has no listing cards: the job page itself carries the whole vacancy. */
const JOB_PAGE_HTML = readFileSync(
  fileURLToPath(new URL('./fixtures/greenhouse-job.html', import.meta.url)),
  'utf8',
);
const GREENHOUSE_URL = 'https://job-boards.eu.greenhouse.io/growe/jobs/4987494101';
/** Indeed's feed: the cards carry a snippet, and the one full description lives in the pane. */
const INDEED_FEED_HTML = readFileSync(
  fileURLToPath(new URL('./fixtures/indeed-feed.html', import.meta.url)),
  'utf8',
);
const INDEED_URL = 'https://pt.indeed.com/';
const INDEED_SELECTED = '1e8f8f14586c5ce3';

function jobPage(html: string, url: string = GREENHOUSE_URL): Document {
  return new JSDOM(html, { url }).window.document;
}

/**
 * Read a page the way the extension does: with the strategy of the site that owns it
 * (`sites/<site>.js`). The plans *are* what the workers hand to the injected reader, so these tests
 * exercise the real plugins - a plan a site malformed fails here rather than in a browser.
 */
function read(doc: Document, site: { plan: unknown }): ReturnType<typeof extractVacancies> {
  return extractVacancies(doc, { plan: site.plan });
}

function page(html: string): Document {
  return new JSDOM(html, { url: 'https://djinni.co/jobs/?primary_keyword=Python' }).window.document;
}

/** Indeed's feed is a whole page (cards *and* the pane), so it is not wrapped like a card sample. */
function indeedPage(html: string = INDEED_FEED_HTML): Document {
  return new JSDOM(html, { url: INDEED_URL }).window.document;
}

describe('vacancy scraper', () => {
  it('reads every card, preferring the full description over the preview', () => {
    const result = read(page(CARD_HTML), djinni);
    expect(result.error).toBeNull();
    expect(result.mode).toBe('cards');
    expect(result.skipped).toBe(0);
    expect(result.vacancies).toHaveLength(2);

    const [first, second] = result.vacancies;
    expect(first.external_id).toBe('848944');
    expect(first.title).toBe('Platform Engineering Lead');
    expect(first.company).toBe('UPPeople');
    expect(first.source_url).toBe('https://djinni.co/jobs/848944/');
    // The preview says "Join our team..." - the full text must win.
    expect(first.description_raw).toContain('We are looking for a hands-on');
    expect(first.description_raw).not.toContain('Join our team');
    // Paragraph breaks survive, and the markup does not.
    expect(first.description_raw.split('\n')).toContain('About the Role');
    expect(first.description_raw).not.toContain('<p>');

    expect(second.external_id).toBe('849001');
    expect(second.company).toBe('Acme Data');
  });

  it('skips a card with no usable text instead of emitting an invalid vacancy', () => {
    const html = `
      <div id="job-item-1" class="job-item">
        <h2 class="job-item__position">Real vacancy</h2>
        <span class="small text-gray-800">Co</span>
        <div id="job-description-1"><span class="js-original-text"><p>Body</p></span></div>
      </div>
      <div id="job-item-2" class="job-item"><h2 class="job-item__position">No description</h2></div>`;
    const result = read(page(html), djinni);
    expect(result.vacancies).toHaveLength(1);
    expect(result.skipped).toBe(1);
  });

  it('resolves a root-relative link against the page URL', () => {
    const html = `
      <div id="job-item-77" class="job-item">
        <h2 class="job-item__position">Relative vacancy</h2>
        <a href="/jobs/77/">open</a>
        <div id="job-description-77"><span class="js-original-text">Text</span></div>
      </div>`;
    const result = read(page(html), djinni);
    expect(result.vacancies[0].source_url).toBe('https://djinni.co/jobs/77/');
  });

  it('honours the batch cap (the endpoint rejects more than 25)', () => {
    const cards = Array.from(
      { length: 40 },
      (_, i) =>
        `<div id="job-item-${i}" class="job-item"><h2 class="job-item__position">V${i}</h2>` +
        `<div><span class="js-original-text">Body ${i}</span></div></div>`,
    ).join('');
    expect(read(page(`<div>${cards}</div>`), djinni).vacancies).toHaveLength(25);
  });

  it('survives a page with no vacancy cards', () => {
    // `cards` is the strategy that was *asked for*, and it found none: `mode` names the strategy, not
    // its luck - which is what lets a caller tell "nothing here" from "no strategy for this page".
    expect(read(page('<div>nothing here</div>'), GENERIC)).toEqual({
      vacancies: [],
      skipped: 0,
      error: null,
      mode: 'cards',
    });
  });

  it('refuses to read a page no strategy was chosen for', () => {
    const result = extractVacancies(page('<div>nothing here</div>'));
    expect(result.mode).toBe('none');
    expect(result.error).toBe('no site strategy for this page');
    expect(result.vacancies).toEqual([]);
  });

  it('refuses a strategy kind it does not know, instead of guessing', () => {
    const result = extractVacancies(page('<div>nothing here</div>'), { plan: { kind: 'nope' } });
    expect(result.mode).toBe('none');
    expect(result.error).toContain('unknown strategy kind');
  });
});

describe('vacancy scraper: a board that renders the vacancy on the job page', () => {
  /**
   * Greenhouse's boards have no cards at all - the job page *is* the vacancy. The id comes from
   * the URL (`/jobs/<id>`, the same shape the gateway derives from a pasted link) and the text
   * from the page, which is why one vacancy comes out of it instead of a card list.
   */
  it('reads the job page as a single vacancy', () => {
    const result = read(jobPage(JOB_PAGE_HTML), greenhouse);
    expect(result.error).toBeNull();
    expect(result.skipped).toBe(0);
    expect(result.vacancies).toHaveLength(1);

    const job = result.vacancies[0];
    expect(job.external_id).toBe('4987494101');
    expect(job.title).toBe('Senior .NET Engineer');
    expect(job.company).toBe('GROWE');
    expect(job.source_url).toBe(GREENHOUSE_URL);
    expect(job.description_raw).toContain('microservices in a production environment');
    expect(job.description_raw).toContain('Terraform');
    expect(job.description_raw).not.toContain('<p>');
  });

  it('falls back to the board when the page title names no company', () => {
    const html = JOB_PAGE_HTML.replace(' at GROWE</title>', ' | Greenhouse</title>');
    expect(read(jobPage(html), greenhouse).vacancies[0].company).toBe('growe');
  });

  it('leaves a board page alone when the URL names no job', () => {
    const board = jobPage(JOB_PAGE_HTML, 'https://job-boards.eu.greenhouse.io/growe');
    expect(read(board, greenhouse).vacancies).toEqual([]);
    expect(read(board, greenhouse).skipped).toBe(0);
  });

  it('does not turn an unrelated page into a vacancy', () => {
    // The same selectors, under a URL with no `/jobs/<id>`: this stays a card list.
    expect(read(page(JOB_PAGE_HTML), GENERIC).vacancies).toEqual([]);
  });
});

describe('vacancy scraper: a feed whose one description lives in a side pane', () => {
  /**
   * Indeed's feed (live page 2026-10-05): 12 cards on the left, a pane on the right holding the
   * full text of whichever card is selected - and *only* that one. So this page yields the selected
   * vacancy, never a list: the cards carry a snippet, and a snippet filed as `description_raw`
   * would tailor a CV against marketing copy.
   */
  it('reads the selected card and the pane the page is showing', () => {
    const result = read(indeedPage(), indeed);
    expect(result.error).toBeNull();
    expect(result.mode).toBe('pane');
    expect(result.skipped).toBe(0);
    expect(result.vacancies).toHaveLength(1);

    const job = result.vacancies[0];
    expect(job.external_id).toBe(INDEED_SELECTED);
    expect(job.title).toBe('Desenvolvedor .Net');
    expect(job.company).toBe('LUZA Group');
    expect(job.source_url).toBe(`https://pt.indeed.com/viewjob?jk=${INDEED_SELECTED}`);
    // The pane's prose ...
    expect(job.description_raw).toContain('Desenvolver APIs e componentes');
    expect(job.description_raw.split('\n')).toContain('Responsabilidades');
    // ... and neither its own stylesheet nor the page's apply machinery.
    expect(job.description_raw).not.toContain('<style>');
    expect(job.description_raw).not.toContain('border-collapse');
    expect(job.description_raw).not.toContain('Candidatar-se');
  });

  it('falls back to the pane`s own id when no card is marked as selected', () => {
    const result = read(indeedPage(INDEED_FEED_HTML.replace('vjs-highlight', 'vjs-x')), indeed);
    expect(result.mode).toBe('pane');
    expect(result.vacancies[0].external_id).toBe(INDEED_SELECTED);
  });

  it('files nothing when no pane is rendered, instead of a card snippet', () => {
    // The rule this shape exists for: 12 cards with 12 snippets must not become 12 vacancies. The
    // page stays *recognised* as an Indeed feed, which is what lets the popup say "the pane has not
    // finished" rather than "no vacancy cards found" - a lie where the cards are on the page.
    const doc = indeedPage();
    doc.querySelector('[data-testid="viewjob-main-content"]')?.remove();
    const result = read(doc, indeed);
    expect(result.vacancies).toEqual([]);
    expect(result.mode).toBe('pane');
  });

  it('describes the vacancy the pane names, not the card that happens to be highlighted', () => {
    // The race this shape must survive: the highlight can land a beat before the pane's text
    // changes. The pane renders its own `fromjk`, so it - not the highlight - names the vacancy, and
    // the id, the title, the company and the text then all come from that one rendered thing.
    const doc = indeedPage();
    doc.querySelector('.vjs-highlight')?.classList.remove('vjs-highlight');
    const other = Array.from(doc.querySelectorAll('div.cardOutline')).find(
      (card) => card.querySelector('a[data-jk]')?.getAttribute('data-jk') !== INDEED_SELECTED,
    );
    other?.classList.add('vjs-highlight');
    const highlighted = other?.querySelector('a[data-jk]')?.getAttribute('data-jk');

    const result = read(doc, indeed);
    expect(result.mode).toBe('pane');
    expect(highlighted).not.toBe(INDEED_SELECTED); // the fixture put the highlight elsewhere
    expect(result.vacancies[0].external_id).toBe(INDEED_SELECTED);
    expect(result.vacancies[0].title).toBe('Desenvolvedor .Net');
    expect(result.vacancies[0].company).toBe('LUZA Group');
    expect(result.vacancies[0].description_raw).toContain('Desenvolver APIs e componentes');
  });

  it('is not mistaken for a card list by the other shapes', () => {
    // The cards are there (12 of them), so only the pane-less guard keeps this from being read as
    // Djinni markup: no `div[id^="job-item-"]` exists on Indeed.
    const doc = indeedPage();
    expect(doc.querySelectorAll('div[id^="job-item-"]')).toHaveLength(0);
    expect(doc.querySelectorAll('div.cardOutline')).toHaveLength(12);
  });
});
