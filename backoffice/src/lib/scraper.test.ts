import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { extractVacancies } from '../../../extension/src/extract.js';

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

function jobPage(html: string, url: string = GREENHOUSE_URL): Document {
  return new JSDOM(html, { url }).window.document;
}

function page(html: string): Document {
  return new JSDOM(html, { url: 'https://djinni.co/jobs/?primary_keyword=Python' }).window.document;
}

describe('vacancy scraper', () => {
  it('reads every card, preferring the full description over the preview', () => {
    const result = extractVacancies(page(CARD_HTML));
    expect(result.error).toBeNull();
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
    const result = extractVacancies(page(html));
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
    const result = extractVacancies(page(html));
    expect(result.vacancies[0].source_url).toBe('https://djinni.co/jobs/77/');
  });

  it('honours the batch cap (the endpoint rejects more than 25)', () => {
    const cards = Array.from(
      { length: 40 },
      (_, i) =>
        `<div id="job-item-${i}" class="job-item"><h2 class="job-item__position">V${i}</h2>` +
        `<div><span class="js-original-text">Body ${i}</span></div></div>`,
    ).join('');
    expect(extractVacancies(page(`<div>${cards}</div>`)).vacancies).toHaveLength(25);
  });

  it('survives a page with no vacancy cards', () => {
    expect(extractVacancies(page('<div>nothing here</div>'))).toEqual({
      vacancies: [],
      skipped: 0,
      error: null,
    });
  });
});

describe('vacancy scraper: a board that renders the vacancy on the job page', () => {
  /**
   * Greenhouse's boards have no cards at all - the job page *is* the vacancy. The id comes from
   * the URL (`/jobs/<id>`, the same shape the gateway derives from a pasted link) and the text
   * from the page, which is why one vacancy comes out of it instead of a card list.
   */
  it('reads the job page as a single vacancy', () => {
    const result = extractVacancies(jobPage(JOB_PAGE_HTML));
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
    expect(extractVacancies(jobPage(html)).vacancies[0].company).toBe('growe');
  });

  it('leaves a board page alone when the URL names no job', () => {
    const board = jobPage(JOB_PAGE_HTML, 'https://job-boards.eu.greenhouse.io/growe');
    expect(extractVacancies(board).vacancies).toEqual([]);
    expect(extractVacancies(board).skipped).toBe(0);
  });

  it('does not turn an unrelated page into a vacancy', () => {
    // The same selectors, under a URL with no `/jobs/<id>`: this stays a card list.
    expect(extractVacancies(page(JOB_PAGE_HTML)).vacancies).toEqual([]);
  });
});
