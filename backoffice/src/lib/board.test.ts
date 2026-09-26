import { describe, expect, it } from 'vitest';
import {
  MAX_ACTION_LENGTH,
  RESTORE_ACTION,
  countArchived,
  countByStage,
  countColumns,
  groupByStage,
  historyLine,
  parseArchiveRequest,
  parseMoveRequest,
  parseRestoreRequest,
} from './board';
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
    archivedAt: null,
    archivedActor: null,
    archivedReason: null,
    archived: false,
    history: [],
    ...overrides,
  };
}

/** The shape the DB writes when a card is refused. */
function archivedCard(overrides: Partial<BoardCard> = {}): BoardCard {
  return card({
    archivedAt: '2026-09-25T12:00:00.000Z',
    archivedActor: 'Company',
    archivedReason: 'Salary mismatch',
    archived: true,
    ...overrides,
  });
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
  const valid = { jobId: '374001-1', to: 'applied', actor: 'Candidate', action: 'Applied online' };

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

describe('archive and restore requests (the refusal dialog)', () => {
  it('accepts the dialog contract and trims the reason', () => {
    const parsed = parseArchiveRequest({ jobId: ' a-1 ', actor: 'Company', action: '  Salary mismatch ' });
    expect(parsed).toEqual({ ok: true, value: { jobId: 'a-1', actor: 'Company', action: 'Salary mismatch' } });
  });

  it('rejects the pre-2026-09-26 actor vocabulary and anything over the limit', () => {
    const base = { jobId: 'a-1', actor: 'Candidate', action: 'Rejected by company' };
    for (const actor of ['Me', 'Them', 'someone', '', null]) {
      expect(parseArchiveRequest({ ...base, actor }).ok, String(actor)).toBe(false);
    }
    expect(parseArchiveRequest({ ...base, action: '   ' }).ok).toBe(false);
    expect(parseArchiveRequest({ ...base, action: 'x'.repeat(MAX_ACTION_LENGTH + 1) }).ok).toBe(false);
    expect(parseArchiveRequest({ ...base, jobId: '' }).ok).toBe(false);
    expect(parseArchiveRequest(null).ok).toBe(false);
    expect(parseArchiveRequest([base]).ok).toBe(false);
  });

  it('takes a job id and nothing else for a restore', () => {
    expect(parseRestoreRequest({ jobId: ' a-1 ' })).toEqual({ ok: true, value: { jobId: 'a-1' } });
    expect(parseRestoreRequest({}).ok).toBe(false);
    expect(parseRestoreRequest({ jobId: 42 }).ok).toBe(false);
    expect(parseRestoreRequest('a-1').ok).toBe(false);
    // The restore reason is recorded by the route, not typed by the operator.
    expect(RESTORE_ACTION).toBe('Restored to the active pipeline');
  });

  it('still refuses "archived" as a column id on a move', () => {
    expect(parseMoveRequest({ jobId: 'a-1', to: 'archived', actor: 'Candidate', action: 'x' }).ok).toBe(
      false,
    );
  });
});

describe('active vs archived counting (column headers)', () => {
  it('splits each column and keeps the total', () => {
    const cards = [
      card({ jobId: 'a', stage: 'interviewing' }),
      card({ jobId: 'b', stage: 'interviewing' }),
      archivedCard({ jobId: 'c', stage: 'interviewing' }),
      archivedCard({ jobId: 'd', stage: 'applied' }),
    ];

    expect(countColumns(cards)[3]).toEqual({ stage: 'interviewing', active: 2, archived: 1, total: 3 });
    expect(countColumns(cards)[1]).toEqual({ stage: 'applied', active: 0, archived: 1, total: 1 });
    // countByStage feeds the nav panel, which counts the pipeline *in play*.
    expect(countByStage(cards).interviewing).toBe(2);
    expect(countByStage(cards).applied).toBe(0);
    expect(countArchived(cards)).toBe(2);
  });

  it('renders both history vocabularies', () => {
    expect(
      historyLine({
        id: 1,
        at: '2026-09-25T12:00:00.000Z',
        actor: 'Company',
        action: 'Salary mismatch',
        kind: 'archive',
        from: 'active',
        to: 'archived',
      }),
    ).toBe('archived: active → refused');
    expect(
      historyLine({
        id: 2,
        at: '2026-09-25T13:00:00.000Z',
        actor: 'Candidate',
        action: RESTORE_ACTION,
        kind: 'restore',
        from: 'archived',
        to: 'active',
      }),
    ).toBe('restored: refused → active');
    expect(
      historyLine({
        id: 3,
        at: '2026-09-25T14:00:00.000Z',
        actor: 'Candidate',
        action: 'Applied online',
        kind: 'move',
        from: 'created',
        to: 'applied',
      }),
    ).toBe('stage: Created → Applied');
  });
});
