import { describe, expect, it } from 'vitest';
import {
  MAX_APPLY_URL_LENGTH,
  normalizeApplyUrl,
  parseApplyUrl,
  parseLinkQuery,
} from './applyUrl';

/**
 * The one rule two callers share: the store (`parseDetailsRequest`) and the lookup
 * (`GET /api/vacancies/link`). Both have to agree, or a card would be saved under a URL the
 * applier can never match.
 */

const GREENHOUSE = 'https://job-boards.eu.greenhouse.io/growe/jobs/4987494101';

describe('an application URL is canonicalised, not stored raw', () => {
  it('keeps the parts that identify the posting and drops the rest', () => {
    expect(normalizeApplyUrl(GREENHOUSE)).toBe(GREENHOUSE);
    // The case that matters: a page reached through a tracking link must match the stored card.
    expect(normalizeApplyUrl(`${GREENHOUSE}?gh_src=abc123#apply`)).toBe(GREENHOUSE);
    expect(normalizeApplyUrl(`${GREENHOUSE}/`)).toBe(GREENHOUSE);
    expect(normalizeApplyUrl(`  ${GREENHOUSE}  `)).toBe(GREENHOUSE);
    expect(normalizeApplyUrl('https://Job-Boards.EU.Greenhouse.IO/growe/jobs/1')).toBe(
      'https://job-boards.eu.greenhouse.io/growe/jobs/1',
    );
  });

  it('keeps a query parameter that identifies the posting', () => {
    // Greenhouse renders a whole board at one path, so there the query *is* the vacancy. Dropping
    // it made the stored URL a dead link and two postings indistinguishable (reported 2026-10-08).
    const board = 'https://www.dremio.com/careers/job-postings/';
    expect(normalizeApplyUrl(`${board}?gh_jid=7822098003`)).toBe(
      'https://www.dremio.com/careers/job-postings?gh_jid=7822098003',
    );
    expect(normalizeApplyUrl(`${board}?gh_jid=7822098003`)).not.toBe(
      normalizeApplyUrl(`${board}?gh_jid=7822098004`),
    );
    // ...and the embed form's own id, which is the page the filler actually stands on.
    expect(normalizeApplyUrl('https://job-boards.greenhouse.io/embed/job_app?token=1&for=dremio')).toBe(
      'https://job-boards.greenhouse.io/embed/job_app?token=1&for=dremio',
    );
  });

  it('drops a tracking tail even when it travels with an identity parameter', () => {
    expect(
      normalizeApplyUrl('https://example.com/apply?gh_jid=7&gh_src=abc&utm_source=li#top'),
    ).toBe('https://example.com/apply?gh_jid=7');
  });

  it('never carries credentials into the column', () => {
    expect(normalizeApplyUrl('https://user:pw@example.com/jobs/1')).toBe(
      'https://example.com/jobs/1',
    );
  });

  it('keeps the path as written - only the host is case-insensitive', () => {
    expect(normalizeApplyUrl('https://example.com/Growe/Jobs/1')).toBe(
      'https://example.com/Growe/Jobs/1',
    );
  });

  it('refuses anything that is not http(s), and anything that is not a URL', () => {
    expect(normalizeApplyUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeApplyUrl('mailto:me@example.com')).toBeNull();
    expect(normalizeApplyUrl('/jobs/4987494101')).toBeNull();
    expect(normalizeApplyUrl('')).toBeNull();
    expect(normalizeApplyUrl(null)).toBeNull();
  });
});

describe('the Details form field', () => {
  it('stores the canonical URL and clears to null when emptied', () => {
    expect(parseApplyUrl(`${GREENHOUSE}/?utm=1`)).toEqual({ ok: true, value: GREENHOUSE });
    expect(parseApplyUrl('')).toEqual({ ok: true, value: null });
    expect(parseApplyUrl('   ')).toEqual({ ok: true, value: null });
    expect(parseApplyUrl(null)).toEqual({ ok: true, value: null });
  });

  it('refuses text, a wrong scheme and a value over the column cap', () => {
    expect(parseApplyUrl(42).ok).toBe(false);
    const wrongScheme = parseApplyUrl('ftp://example.com/jobs/1');
    expect(wrongScheme.ok).toBe(false);
    expect(wrongScheme.ok === false && wrongScheme.error).toMatch(/http\(s\)/);
    expect(parseApplyUrl(`https://example.com/${'x'.repeat(MAX_APPLY_URL_LENGTH)}`).ok).toBe(false);
  });
});

describe('the lookup the applier asks', () => {
  it('normalises the page URL the browser handed over', () => {
    expect(parseLinkQuery(`${GREENHOUSE}/?gh_src=x`)).toEqual({ ok: true, value: GREENHOUSE });
  });

  it('answers the same value the Details form would have stored', () => {
    // The whole point of one shared rule: the page the applier stands on canonicalises to exactly
    // what the card holds - identity parameter kept, tracking tail gone.
    expect(
      parseLinkQuery('https://www.dremio.com/careers/job-postings/?gh_jid=7822098003&gh_src=x'),
    ).toEqual({
      ok: true,
      value: 'https://www.dremio.com/careers/job-postings?gh_jid=7822098003',
    });
  });

  it('rejects a missing or unusable query param', () => {
    expect(parseLinkQuery('').ok).toBe(false);
    expect(parseLinkQuery(null).ok).toBe(false);
    expect(parseLinkQuery('djinni.co/jobs/848944').ok).toBe(false);
    expect(parseLinkQuery(`https://example.com/${'x'.repeat(MAX_APPLY_URL_LENGTH)}`).ok).toBe(
      false,
    );
  });
});
