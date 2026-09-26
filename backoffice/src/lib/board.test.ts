import { describe, expect, it } from 'vitest';
import { MAX_ACTION_LENGTH, countByStage, groupByStage, parseMoveRequest } from './board';
import { STAGES, isStageId, tailoringFromStatus } from './stages';
import type { BoardCard } from './types';

function card(overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    jobId: '374001-1',
    externalId: '374001',
    title: 'Senior Data Engineer',
    company: 'InScale',
    sourceUrl: null,
    cvVersion: 'v1',
    status: 'completed',
    attempts: 1,
    revisionCount: 1,
    durationMs: 12000,
    error: null,
    pdfUrl: null,
    docxPath: null,
    createdAt: '2026-09-25T10:00:00.000Z',
    updatedAt: '2026-09-25T10:05:00.000Z',
    stage: 'created',
    history: [],
    ...overrides,
  };
}

describe('tailoringFromStatus (the worker owns this state)', () => {
  it('maps in-flight statuses to Tailoring In Progress', () => {
    for (const status of ['queued', 'processing', 'rendering', 'validating', 'uploading']) {
      expect(tailoringFromStatus(status)).toBe('in_progress');
    }
  });

  it('maps completed and skipped to Tailored', () => {
    expect(tailoringFromStatus('completed')).toBe('tailored');
    expect(tailoringFromStatus('skipped')).toBe('tailored');
  });

  it('maps parked statuses to Tailoring Failed', () => {
    for (const status of ['failed', 'rate_limited', 'dead_lettered']) {
      expect(tailoringFromStatus(status)).toBe('failed');
    }
  });
});

describe('parseMoveRequest (the dialog contract)', () => {
  const valid = { jobId: '374001-1', to: 'applied', actor: 'Me', action: 'Applied online' };

  it('accepts a well-formed move and trims the reason', () => {
    const parsed = parseMoveRequest({ ...valid, action: '  Applied online  ' });
    expect(parsed).toEqual({ ok: true, value: { ...valid, action: 'Applied online' } });
  });

  it('rejects a missing job id, an unknown column, a bad actor and an empty reason', () => {
    expect(parseMoveRequest({ ...valid, jobId: '  ' }).ok).toBe(false);
    expect(parseMoveRequest({ ...valid, to: 'archived' }).ok).toBe(false);
    expect(parseMoveRequest({ ...valid, actor: 'Someone' }).ok).toBe(false);
    expect(parseMoveRequest({ ...valid, action: '   ' }).ok).toBe(false);
    expect(parseMoveRequest(null).ok).toBe(false);
  });

  it('rejects a reason longer than the database accepts', () => {
    const parsed = parseMoveRequest({ ...valid, action: 'x'.repeat(MAX_ACTION_LENGTH + 1) });
    expect(parsed.ok).toBe(false);
  });
});

describe('board grouping', () => {
  it('buckets cards per column, newest change first, and counts them', () => {
    const columns = groupByStage([
      card({ jobId: 'a', stage: 'created', updatedAt: '2026-09-25T10:00:00.000Z' }),
      card({ jobId: 'b', stage: 'created', updatedAt: '2026-09-25T11:00:00.000Z' }),
      card({ jobId: 'c', stage: 'offer' }),
    ]);

    expect(columns.map((column) => column.stage)).toEqual(STAGES.map((stage) => stage.id));
    expect(columns[0].cards.map((item) => item.jobId)).toEqual(['b', 'a']);
    expect(columns[4].cards.map((item) => item.jobId)).toEqual(['c']);
    expect(countByStage([card({ stage: 'created' }), card({ stage: 'created' }), card({ stage: 'applied' })])).toEqual({
      created: 2,
      applied: 1,
      negotiating: 0,
      interviewing: 0,
      offer: 0,
    });
  });

  it('only accepts the five column ids', () => {
    expect(isStageId('negotiating')).toBe(true);
    expect(isStageId('archived')).toBe(false);
    expect(isStageId(42)).toBe(false);
  });
});
