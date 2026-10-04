import { describe, expect, it } from 'vitest';
import {
  MAX_BATCH_SIZE,
  MAX_STATUS_IDS,
  parseBatchRequest,
  parseStatusQuery,
  toTaskMessage,
} from './vacancies';

const card = {
  external_id: '848944',
  title: 'Platform Engineering Lead',
  company: 'UPPeople',
  description_raw: 'About the Role\nWe are looking for a hands-on Full-Stack Engineer.',
  source_url: 'https://djinni.co/jobs/848944/',
};

describe('batch validation', () => {
  it('accepts a scraped listing and trims the fields', () => {
    const parsed = parseBatchRequest({ vacancies: [{ ...card, title: '  Platform Engineering Lead  ' }] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.vacancies).toHaveLength(1);
    expect(parsed.vacancies[0].title).toBe('Platform Engineering Lead');
    expect(parsed.duplicates).toBe(0);
  });

  it('collapses a vacancy that appears twice on one page', () => {
    const parsed = parseBatchRequest({ vacancies: [card, { ...card, title: 'duplicate card' }] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.vacancies).toHaveLength(1);
    expect(parsed.duplicates).toBe(1);
    expect(parsed.vacancies[0].title).toBe('Platform Engineering Lead');
  });

  it('rejects what the worker could not use, naming the item', () => {
    const cases: Array<[unknown, RegExp]> = [
      [null, /body must be a JSON object/],
      [{}, /vacancies must be an array/],
      [{ vacancies: [] }, /vacancies is empty/],
      [{ vacancies: [null] }, /vacancies\[0\] must be an object/],
      [{ vacancies: [{ description_raw: 'x' }] }, /vacancies\[0\]\.external_id is required/],
      [{ vacancies: [{ external_id: '1', description_raw: '   ' }] }, /vacancies\[0\]\.description_raw is required/],
      [
        { vacancies: [{ ...card, source_url: 'javascript:alert(1)' }] },
        /vacancies\[0\]\.source_url must be http/,
      ],
      [
        { vacancies: Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) => ({ ...card, external_id: String(i) })) },
        /too many vacancies/,
      ],
    ];
    for (const [body, pattern] of cases) {
      const parsed = parseBatchRequest(body);
      expect(parsed.ok, JSON.stringify(body)?.slice(0, 60)).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.error).toMatch(pattern);
    }
  });

  it('rejects an absurdly long description rather than shipping it to the broker', () => {
    const parsed = parseBatchRequest({
      vacancies: [{ ...card, description_raw: 'x'.repeat(200_001) }],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/too long/);
  });
});

describe('status lookup (the injected buttons ask this)', () => {
  it('takes a comma-separated list and de-duplicates it', () => {
    expect(parseStatusQuery('850374, 850359,850374 ,,')).toEqual({
      ok: true,
      ids: ['850374', '850359'],
      source: 'djinni',
    });
  });

  it('rejects an empty, oversized or invalid list', () => {
    expect(parseStatusQuery('')).toMatchObject({ ok: false });
    expect(parseStatusQuery(null)).toMatchObject({ ok: false });
    expect(parseStatusQuery(',,')).toMatchObject({ ok: false });
    expect(parseStatusQuery('a b')).toMatchObject({ ok: false }); // a space would need encoding
    expect(parseStatusQuery('x'.repeat(301))).toMatchObject({ ok: false });
    expect(
      parseStatusQuery(Array.from({ length: MAX_STATUS_IDS + 1 }, (_, i) => String(i)).join(',')),
    ).toMatchObject({ ok: false });
    expect(
      parseStatusQuery(Array.from({ length: MAX_STATUS_IDS }, (_, i) => String(i)).join(',')).ok,
    ).toBe(true);
  });

  it('accepts what the DB shape guard accepts', () => {
    expect(parseStatusQuery('smoke_test,848944-1789668742,u-1:v2').ok).toBe(true);
  });
});

describe('task payload', () => {
  it('matches the worker contract (ResumeTaskMessage)', () => {
    const parsed = parseBatchRequest({ vacancies: [card] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const message = toTaskMessage(parsed.vacancies[0], 'u-abc', {
      jobId: '11111111-2222-3333-4444-555555555555',
      now: new Date('2026-01-02T03:04:05.000Z'),
    });

    expect(message).toMatchObject({
      job_id: '11111111-2222-3333-4444-555555555555',
      user_id: 'u-abc',
      external_id: '848944',
      source: 'djinni',
      title: 'Platform Engineering Lead',
      company: 'UPPeople',
      source_url: 'https://djinni.co/jobs/848944/',
      cv_version: 'v1',
      attempt: 0,
      enqueued_at: '2026-01-02T03:04:05.000Z',
    });
    // The worker downloads the master CV and validates it against cv.docx.
    expect(message).not.toHaveProperty('cv_data');
    // job_id must satisfy the DB shape guard in apps/worker/utils/db.py.
    expect(String(message.job_id)).toMatch(/^[A-Za-z0-9_.:-]+$/);
  });

  it('omits source_url only when the card had none', () => {
    const parsed = parseBatchRequest({
      vacancies: [{ external_id: '1', description_raw: 'text' }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const message = toTaskMessage(parsed.vacancies[0], 'u-abc', { jobId: 'job-1' });
    expect(message.source_url).toBeNull();
    expect(message.title).toBe('');
  });
});

describe('the vacancy source (site slug)', () => {
  it('defaults to djinni, so an extension that predates `source` keeps working', () => {
    const parsed = parseBatchRequest({ vacancies: [card] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.source).toBe('djinni');
  });

  it('is per request and reaches the task message', () => {
    const parsed = parseBatchRequest({ source: 'dou', vacancies: [card] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.source).toBe('dou');

    const message = toTaskMessage(parsed.vacancies[0], 'u-abc', {
      jobId: 'job-dou',
      source: 'dou',
    });
    expect(message.source).toBe('dou');
  });

  it('normalises case and rejects what the DB shape guard would refuse', () => {
    const upper = parseBatchRequest({ source: 'DOU', vacancies: [card] });
    expect(upper.ok).toBe(true);
    if (upper.ok) expect(upper.source).toBe('dou');

    // A longer slug is truncated (asText caps the field), so the invalid cases are
    // the ones the shape guard actually rejects.
    for (const source of ['x', 'a b', 'dou!', '-dou']) {
      expect(parseBatchRequest({ source, vacancies: [card] }).ok, source).toBe(false);
    }
  });

  it('is validated for the status lookup too (the extension sends it as a query param)', () => {
    expect(parseStatusQuery('850374', 'dou')).toMatchObject({ ok: true, source: 'dou' });
    expect(parseStatusQuery('850374', 'not a slug')).toMatchObject({ ok: false });
  });
});
