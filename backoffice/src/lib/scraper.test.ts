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
