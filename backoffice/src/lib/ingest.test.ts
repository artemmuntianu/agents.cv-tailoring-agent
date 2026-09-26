import { describe, expect, it } from 'vitest';
import { INGEST_STATUS, STALE_INGEST_MS, planIngest } from './ingest';
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
  updatedAt = new Date().toISOString(),
  archived = false,
): [string, ExistingVacancy] => [
  externalId,
  { jobId: `row-${externalId}`, status, updatedAt, archived },
];

const now = new Date('2026-01-02T12:00:00.000Z');
const options = { makeJobId: () => 'new-job-id', now };

describe('ingest plan', () => {
  it('creates the row and publishes for a vacancy the board has never seen', () => {
    const plan = planIngest([vacancy('100')], new Map(), options);
    expect(plan.insert).toHaveLength(1);
    expect(plan.insert[0].jobId).toBe('new-job-id');
    expect(plan.publish).toEqual([
      { vacancy: expect.objectContaining({ external_id: '100' }), jobId: 'new-job-id', retry: false },
    ]);
    expect(plan.duplicates).toBe(0);
  });

  it('does not queue a vacancy twice while it is in flight', () => {
    for (const status of [INGEST_STATUS, 'queued', 'processing', 'rendering']) {
      const plan = planIngest([vacancy('100')], new Map([existing('100', status)]), options);
      expect(plan.publish, status).toHaveLength(0);
      expect(plan.insert, status).toHaveLength(0);
      expect(plan.duplicates, status).toBe(1);
    }
  });

  it('treats a finished (or skipped) vacancy as already handled', () => {
    for (const status of ['completed', 'skipped']) {
      const plan = planIngest([vacancy('100')], new Map([existing('100', status)]), options);
      expect(plan.publish, status).toHaveLength(0);
      expect(plan.duplicates, status).toBe(1);
      expect(plan.retries, status).toBe(0);
    }
  });

  it('never re-queues a refused (archived) vacancy, whatever its status says', () => {
    // A card archived while failed is the interesting case: without the archived flag
    // the retry rule above would happily send it to Gemini again.
    for (const status of ['failed', 'completed', INGEST_STATUS]) {
      const plan = planIngest(
        [vacancy('100')],
        new Map([existing('100', status, new Date().toISOString(), true)]),
        options,
      );
      expect(plan.publish, status).toHaveLength(0);
      expect(plan.insert, status).toHaveLength(0);
      expect(plan.retries, status).toBe(0);
      expect(plan.duplicates, status).toBe(1);
    }
  });

  it('re-queues a failed card under its own job_id - the board card is that row', () => {
    for (const status of ['failed', 'rate_limited', 'dead_lettered']) {
      const plan = planIngest([vacancy('100')], new Map([existing('100', status)]), options);
      expect(plan.publish, status).toHaveLength(1);
      expect(plan.publish[0].jobId, status).toBe('row-100');
      expect(plan.publish[0].retry, status).toBe(true);
      expect(plan.insert, status).toHaveLength(0);
      expect(plan.retries, status).toBe(1);
    }
  });

  it('re-queues an abandoned ingest row after the stale window, and not before', () => {
    const stale = new Date(now.getTime() - STALE_INGEST_MS - 1).toISOString();
    const fresh = new Date(now.getTime() - STALE_INGEST_MS + 60_000).toISOString();

    const abandoned = planIngest([vacancy('100')], new Map([existing('100', INGEST_STATUS, stale)]), options);
    expect(abandoned.publish).toHaveLength(1);
    expect(abandoned.publish[0].jobId).toBe('row-100');
    expect(abandoned.retries).toBe(1);

    const inFlight = planIngest([vacancy('100')], new Map([existing('100', INGEST_STATUS, fresh)]), options);
    expect(inFlight.publish).toHaveLength(0);
    expect(inFlight.duplicates).toBe(1);
  });

  it('keeps one decision per vacancy in a mixed batch', () => {
    const plan = planIngest(
      [vacancy('100'), vacancy('200'), vacancy('300')],
      new Map([existing('100', 'completed'), existing('200', 'failed')]),
      { makeJobId: (() => {
        let n = 0;
        return () => `job-${++n}`;
      })(), now },
    );

    expect(plan.publish.map((item) => item.vacancy.external_id)).toEqual(['200', '300']);
    expect(plan.publish.map((item) => item.jobId)).toEqual(['row-200', 'job-1']);
    expect(plan.insert.map((item) => item.jobId)).toEqual(['job-1']);
    expect(plan.duplicates).toBe(1);
    expect(plan.retries).toBe(1);
  });
});
