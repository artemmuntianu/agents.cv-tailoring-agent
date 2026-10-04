import { describe, expect, it } from 'vitest';
import { INGEST_STATUS, planIngest } from './ingest';
import type { ExistingVacancy } from './ingest';
import type { ScrapedVacancy } from './vacancies';

const vacancy = (externalId: string): ScrapedVacancy => ({
  external_id: externalId,
  title: `Role ${externalId}`,
  company: 'ACME',
  description_raw: 'text',
});

const existing = (
  externalId: string,
  status: string,
  archived = false,
): [string, ExistingVacancy] => [
  externalId,
  { jobId: `row-${externalId}`, status, updatedAt: new Date().toISOString(), archived },
];

/** A fresh id generator per test, so the ids a plan mints are predictable. */
const options = () => {
  let n = 0;
  return { makeJobId: () => `new-job-${++n}` };
};

describe('ingest plan (create the card; queueing is the operator\'s drag)', () => {
  it('creates a card for a vacancy the board has never seen', () => {
    const plan = planIngest([vacancy('100')], new Map(), options());
    expect(plan.insert).toHaveLength(1);
    expect(plan.insert[0].jobId).toBe('new-job-1');
    expect(plan.insert[0].vacancy.external_id).toBe('100');
    expect(plan.duplicates).toBe(0);
  });

  it('never creates a second card for a vacancy the board already has', () => {
    // Any status counts, `submitted` included: with the Scraped column a card waits for the
    // operator's decision, and re-scraping the page must not fork it.
    for (const status of [INGEST_STATUS, 'queued', 'processing', 'completed', 'failed']) {
      const plan = planIngest([vacancy('100')], new Map([existing('100', status)]), options());
      expect(plan.insert, status).toHaveLength(0);
      expect(plan.duplicates, status).toBe(1);
    }
  });

  it('leaves a refused vacancy refused', () => {
    for (const status of ['failed', 'completed', INGEST_STATUS]) {
      const plan = planIngest(
        [vacancy('100')],
        new Map([existing('100', status, true)]),
        options(),
      );
      expect(plan.insert, status).toHaveLength(0);
      expect(plan.duplicates, status).toBe(1);
    }
  });

  it('keeps one decision per vacancy in a mixed batch', () => {
    const plan = planIngest(
      [vacancy('100'), vacancy('200'), vacancy('300')],
      new Map([existing('100', 'completed'), existing('200', 'failed')]),
      options(),
    );

    expect(plan.insert.map((item) => item.vacancy.external_id)).toEqual(['300']);
    expect(plan.insert.map((item) => item.jobId)).toEqual(['new-job-1']);
    expect(plan.duplicates).toBe(2);
  });
});
