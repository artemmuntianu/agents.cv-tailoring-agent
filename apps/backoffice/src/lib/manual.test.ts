import { describe, expect, it } from 'vitest';
import { SOURCE_SLUGS } from './cardMeta';
import {
  EMPTY_MANUAL_DRAFT,
  GENERIC_SOURCE,
  SOURCE_SUGGESTIONS,
  canonicalPostingUrl,
  isSourceSlug,
  manualApplyDetails,
  manualBatchBody,
  manualExternalId,
  normalizeSourceSlug,
  parseManualVacancy,
} from './manual';
import { parseBatchRequest } from './vacancies';

/** A complete draft, so each test can break exactly one field. */
function draft(overrides: Partial<typeof EMPTY_MANUAL_DRAFT> = {}) {
  return {
    ...EMPTY_MANUAL_DRAFT,
    title: 'Software Engineer - Developer Experience',
    company: 'Dremio',
    descriptionRaw: 'CI/CD systems and developer productivity.',
    sourceUrl: 'https://job-boards.greenhouse.io/dremio/jobs/7822098003',
    source: 'greenhouse',
    ...overrides,
  };
}

describe('the manual-add contract', () => {
  it('suggests every labelled site plus the honest "not listed" slug', () => {
    // The suggestions are derived from the board's own label map, so a new site is one entry there.
    // This is a *suggestion* list: the field is a combobox, and a slug it does not contain is
    // still accepted (`isSourceSlug`), which is what lets an operator name a site nobody scraped.
    expect(SOURCE_SUGGESTIONS.map((suggestion) => suggestion.slug)).toEqual([
      ...SOURCE_SLUGS,
      GENERIC_SOURCE,
    ]);
    expect(SOURCE_SUGGESTIONS.at(-1)).toEqual({
      slug: GENERIC_SOURCE,
      label: 'Other / not listed',
    });
  });

  it('accepts a site nobody has scraped, and normalises what was typed', () => {
    const parsed = parseManualVacancy(draft({ source: '  Workday  ' }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.source).toBe('workday');
    // ...and it travels to the gateway as the card's own slug, not as the `other` fallback.
    expect(manualBatchBody(parsed.value).source).toBe('workday');

    expect(normalizeSourceSlug('  LinkedIn ')).toBe('linkedin');
    // An empty field is the fallback, not a mistake - so it is not the combobox's hint either.
    expect(isSourceSlug('')).toBe(true);
    expect(isSourceSlug('linkedin')).toBe(true);
    expect(isSourceSlug('my-site-2')).toBe(true);
    expect(isSourceSlug('Not A Slug')).toBe(false);
    expect(isSourceSlug('x')).toBe(false);
  });

  it('requires the fields the tailoring prompt cannot do without', () => {
    expect(parseManualVacancy(draft({ title: '  ' }))).toEqual({
      ok: false,
      error: 'a job title is required',
    });
    expect(parseManualVacancy(draft({ company: '' }))).toEqual({
      ok: false,
      error: 'a company is required',
    });
    expect(parseManualVacancy(draft({ descriptionRaw: '\n ' }))).toEqual({
      ok: false,
      error: 'the job description is required - the tailoring prompt reads it',
    });
    expect(parseManualVacancy(draft({ sourceUrl: '   ' }))).toEqual({
      ok: false,
      error: 'a posting URL is required - the card is keyed on it',
    });
  });

  it('refuses a URL that is not http(s) and a source that is not a slug', () => {
    expect(parseManualVacancy(draft({ sourceUrl: 'dremio.com/jobs/1' })).ok).toBe(false);
    expect(parseManualVacancy(draft({ applyUrl: 'javascript:alert(1)' }))).toEqual({
      ok: false,
      error: 'the application URL must be http(s)',
    });
    expect(parseManualVacancy(draft({ source: 'Not A Slug' })).ok).toBe(false);
  });

  it('normalises what it keeps: whitespace collapsed, the application URL canonicalised', () => {
    const parsed = parseManualVacancy(
      draft({
        title: '  Staff   Engineer  ',
        applyUrl: 'https://job-boards.greenhouse.io/embed/job_app?for=dremio&token=1',
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.title).toBe('Staff Engineer');
    // `lib/applyUrl.ts`'s canonicalisation is the one the filler's lookup uses too, and it keeps an
    // identity query: the embed form's `token`/`for` are what make the page that vacancy.
    expect(parsed.value.applyUrl).toBe(
      'https://job-boards.greenhouse.io/embed/job_app?for=dremio&token=1',
    );
    expect(parsed.value.source).toBe('greenhouse');
  });

  it('defaults the site to the fallback slug and the application URL to nothing', () => {
    const parsed = parseManualVacancy(draft({ source: '', applyUrl: '' }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.source).toBe(GENERIC_SOURCE);
    expect(parsed.value.applyUrl).toBeNull();
  });

  it('keys a card on its posting URL, so re-adding one link is a duplicate', () => {
    // Stable across runs...
    expect(manualExternalId('https://example.com/jobs/1')).toBe(
      manualExternalId('https://example.com/jobs/1'),
    );
    // ...different postings differ...
    expect(manualExternalId('https://example.com/jobs/1')).not.toBe(
      manualExternalId('https://example.com/jobs/2'),
    );
    // ...and the **query is kept**: these are two postings on one board, not one.
    expect(manualExternalId('https://boards.example.com/apply?gh_jid=1')).not.toBe(
      manualExternalId('https://boards.example.com/apply?gh_jid=2'),
    );
    // A trailing slash and a fragment are not identity.
    expect(manualExternalId('https://example.com/jobs/1/')).toBe(
      manualExternalId('https://example.com/jobs/1#apply'),
    );
    expect(manualExternalId('https://example.com/jobs/1')).toMatch(/^m-[0-9a-f]{8}$/);
  });

  it('keeps the posting path case, but lower-cases the origin, when it canonicalises', () => {
    expect(canonicalPostingUrl('HTTPS://Example.com/Jobs/One/?x=1#top')).toBe(
      'https://example.com/Jobs/One?x=1',
    );
    // A value `new URL` cannot parse is left alone rather than mangled.
    expect(canonicalPostingUrl('not a url')).toBe('not a url');
  });

  it('builds a body the gateway itself accepts - one intake, one validator', () => {
    const parsed = parseManualVacancy(draft());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // The real validator, not a shape check: a hand-typed vacancy must be creatable by the code
    // the extension posts to, or the page would be a second, subtly different intake.
    const validated = parseBatchRequest(manualBatchBody(parsed.value));
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.source).toBe('greenhouse');
    expect(validated.vacancies).toEqual([
      {
        external_id: parsed.value.externalId,
        title: parsed.value.title,
        company: parsed.value.company,
        description_raw: parsed.value.descriptionRaw,
        source_url: parsed.value.sourceUrl,
      },
    ]);
  });

  it('writes the application URL as a Details request, and nothing when there is none', () => {
    const parsed = parseManualVacancy(
      draft({ applyUrl: 'https://job-boards.greenhouse.io/embed/job_app' }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(manualApplyDetails('job-1', parsed.value)).toEqual({
      jobId: 'job-1',
      recruiter: null,
      salaryOffered: null,
      salaryDesired: null,
      communicationChannels: [],
      applyUrl: 'https://job-boards.greenhouse.io/embed/job_app',
    });

    const bare = parseManualVacancy(draft());
    expect(bare.ok).toBe(true);
    if (!bare.ok) return;
    expect(manualApplyDetails('job-1', bare.value)).toBeNull();
  });
});
