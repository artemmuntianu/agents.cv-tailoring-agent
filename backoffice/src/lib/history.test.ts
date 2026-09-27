import { describe, expect, it } from 'vitest';
import { MAX_ACTION_LENGTH } from './board';
import {
  ARCHIVE_STATES,
  HISTORY_KINDS,
  KIND_LABEL,
  defaultTransition,
  draftFromHistory,
  draftToRequest,
  isHistoryKind,
  parseHistoryRequest,
  stateLabel,
  stateOptions,
} from './history';
import { STAGES, TAILORING_STATES } from './stages';
import type { HistoryEntry } from './types';

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: 7,
    at: '2026-09-26T09:15:00.000Z',
    actor: 'Candidate',
    action: 'Sent the tailored CV',
    kind: 'move',
    from: 'prepare',
    to: 'applied',
    ...overrides,
  };
}

describe('history vocabulary', () => {
  it('knows exactly the four kinds the DB CHECK allows', () => {
    expect(HISTORY_KINDS).toEqual(['move', 'tailoring', 'archive', 'restore']);
    expect(isHistoryKind('move')).toBe(true);
    expect(isHistoryKind('imported')).toBe(false);
    expect(isHistoryKind(null)).toBe(false);
  });

  it('labels every kind, so the dropdown has no blank option', () => {
    for (const kind of HISTORY_KINDS) expect(KIND_LABEL[kind].length).toBeGreaterThan(0);
  });

  it('offers the states the kind can carry', () => {
    expect(stateOptions('move')).toEqual(STAGES.map((stage) => stage.id));
    expect(stateOptions('tailoring')).toEqual(TAILORING_STATES.map((state) => state.id));
    expect(stateOptions('archive')).toEqual([...ARCHIVE_STATES]);
    expect(stateOptions('restore')).toEqual([...ARCHIVE_STATES]);
    // `archived` is never a stage, and a column is never an archive state.
    expect(stateOptions('move')).not.toContain('archived');
    expect(stateOptions('archive')).not.toContain('applied');
  });

  it('labels a state the way the board does', () => {
    expect(stateLabel('move', 'interviewing')).toBe('Interviewing');
    expect(stateLabel('tailoring', 'in_progress')).toBe('Tailoring In Progress');
    expect(stateLabel('archive', 'archived')).toBe('archived');
    // An unknown state still renders as itself rather than as a wrong column.
    expect(stateLabel('tailoring', 'applied')).toBe('applied');
  });

  it('falls back to the transition that made each kind worth recording', () => {
    expect(defaultTransition('move')).toEqual({ from: 'scraped', to: 'prepare' });
    expect(defaultTransition('tailoring')).toEqual({ from: 'in_progress', to: 'tailored' });
    expect(defaultTransition('archive')).toEqual({ from: 'active', to: 'archived' });
    expect(defaultTransition('restore')).toEqual({ from: 'archived', to: 'active' });
  });
});


describe('parseHistoryRequest', () => {
  it('normalises a datetime-local value to an ISO timestamp', () => {
    const parsed = parseHistoryRequest({
      at: '2026-09-26T11:15',
      actor: 'Company',
      action: '  Rejected by company  ',
      kind: 'archive',
      from: 'active',
      to: 'archived',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.actor).toBe('Company');
    expect(parsed.value.action).toBe('Rejected by company');
    expect(parsed.value.kind).toBe('archive');
    expect(new Date(parsed.value.at).getTime()).toBe(new Date('2026-09-26T11:15').getTime());
  });

  it('accepts an ISO timestamp too', () => {
    const parsed = parseHistoryRequest({
      at: '2026-09-26T09:15:00.000Z',
      actor: 'Candidate',
      action: 'Moved',
      kind: 'move',
      from: 'applied',
      to: 'interviewing',
    });
    expect(parsed.ok && parsed.value.at).toBe('2026-09-26T09:15:00.000Z');
  });

  it('rejects a body that is not an object', () => {
    expect(parseHistoryRequest('nope')).toEqual({ ok: false, error: 'body must be a JSON object' });
  });

  it('rejects a bad timestamp', () => {
    const parsed = parseHistoryRequest({ ...entry(), at: 'yesterday' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('date and time');
  });

  it('rejects an unknown actor and an unknown kind', () => {
    expect(parseHistoryRequest({ ...entry(), actor: 'Me' }).ok).toBe(false);
    expect(parseHistoryRequest({ ...entry(), kind: 'imported' }).ok).toBe(false);
  });

  it('rejects an empty or over-long reason', () => {
    expect(parseHistoryRequest({ ...entry(), action: '   ' }).ok).toBe(false);
    const long = parseHistoryRequest({ ...entry(), action: 'x'.repeat(MAX_ACTION_LENGTH + 1) });
    expect(long.ok).toBe(false);
    if (long.ok) return;
    expect(long.error).toContain(String(MAX_ACTION_LENGTH));
    expect(parseHistoryRequest({ ...entry(), action: 'x'.repeat(MAX_ACTION_LENGTH) }).ok).toBe(true);
  });

  it('checks the two states against the kind, which the DB cannot', () => {
    const mismatched = parseHistoryRequest({
      at: '2026-09-26T09:15',
      actor: 'Candidate',
      action: 'Refused',
      kind: 'archive',
      from: 'applied',
      to: 'archived',
    });
    expect(mismatched.ok).toBe(false);
    if (mismatched.ok) return;
    expect(mismatched.error).toContain('for a archive line');
    expect(mismatched.error).toContain('active');

    const tailoring = parseHistoryRequest({
      at: '2026-09-26T09:15',
      actor: 'Candidate',
      action: 'Tailored',
      kind: 'tailoring',
      from: 'in_progress',
      to: 'tailored',
    });
    expect(tailoring.ok).toBe(true);
  });

  it('accepts a move that does not move (the recorded action)', () => {
    const parsed = parseHistoryRequest({
      at: '2026-09-26T09:15',
      actor: 'Candidate',
      action: 'Followed up by email',
      kind: 'move',
      from: 'applied',
      to: 'applied',
    });
    expect(parsed.ok).toBe(true);
  });
});

describe('draftFromHistory / draftToRequest', () => {
  it('round-trips a stored line through the form shape', () => {
    const parsed = draftToRequest(draftFromHistory(entry()));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      actor: 'Candidate',
      action: 'Sent the tailored CV',
      kind: 'move',
      from: 'prepare',
      to: 'applied',
      at: new Date('2026-09-26T09:15:00.000Z').toISOString(),
    });
  });

  it('gives the form a datetime-local value, not an ISO one', () => {
    // `<input type="datetime-local">` silently drops the zone, so the draft must not carry one.
    expect(draftFromHistory(entry()).at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it('surfaces a mistake as a parse error the dialog can show', () => {
    expect(draftToRequest({ ...draftFromHistory(entry()), action: '  ' }).ok).toBe(false);
  });

  it('keeps an archive line on its own vocabulary', () => {
    const draft = draftFromHistory(
      entry({ kind: 'archive', from: 'active', to: 'archived', action: 'Salary mismatch' }),
    );
    expect(draft.from).toBe('active');
    expect(draft.to).toBe('archived');
    expect(draftToRequest(draft).ok).toBe(true);
  });
});
