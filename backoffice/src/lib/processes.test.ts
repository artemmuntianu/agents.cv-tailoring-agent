import { describe, expect, it } from 'vitest';
import {
  PROCESS_LABELS,
  describeRun,
  formatDuration,
  formatRunStart,
  humanizeKey,
  processHint,
  processLabel,
  runDurationMs,
  runStatus,
  summarizeRuns,
} from './processes';
import type { ProcessRun } from './types';

function run(overrides: Partial<ProcessRun> = {}): ProcessRun {
  return {
    id: 1,
    process: 'feed-parser',
    trigger: 'schedule',
    startedAt: '2026-09-27T08:00:00.000Z',
    finishedAt: '2026-09-27T08:00:04.200Z',
    status: 'ok',
    summary: { new_cards: 3, notified: 3 },
    error: null,
    ...overrides,
  };
}

describe('the process vocabulary', () => {
  it('labels the two jobs the platform runs', () => {
    expect(processLabel('feed-parser')).toBe('XML Feed Parser');
    expect(processLabel('auto-archiver')).toBe('AutoArchiver');
    expect(processHint('auto-archiver')).toContain('archiver');
  });

  it('renders a slug it does not know instead of hiding the row', () => {
    expect(processLabel('nightly-sweeper')).toBe('nightly-sweeper');
    expect(processHint('nightly-sweeper')).toBe('an internal process');
    expect(Object.keys(PROCESS_LABELS).length).toBeGreaterThan(0);
  });

  it('has a chip for every status the database allows, and a fallback', () => {
    for (const status of ['running', 'ok', 'failed', 'skipped', 'aborted']) {
      expect(runStatus(status).label).not.toBe(status === 'ok' ? '' : status);
      expect(runStatus(status).chip).toContain('ring-');
    }
    expect(runStatus('lost').label).toBe('lost');
  });
});

describe('one run, one line', () => {
  it('reads the counters a job reported', () => {
    expect(describeRun(run())).toBe('new cards: 3 · notified: 3');
  });

  it('marks a dry run without counting it', () => {
    expect(describeRun(run({ summary: { dry_run: true, candidates: 2 } }))).toBe(
      'candidates: 2 · dry run',
    );
  });

  it('shows the error instead of counters when a run failed', () => {
    expect(describeRun(run({ status: 'failed', error: 'no feed answered' }))).toBe(
      'no feed answered',
    );
    expect(describeRun(run({ status: 'failed', summary: null, error: 'boom' }))).toBe('boom');
  });

  it('says so when a job reported nothing', () => {
    expect(describeRun(run({ summary: null }))).toBe('no counters reported');
  });

  it('humanises counter keys and survives odd values', () => {
    expect(humanizeKey('new_cards')).toBe('new cards');
    expect(describeRun(run({ summary: { feeds: 'https://jobs.dou.ua/x', empty: null } }))).toBe(
      'feeds: https://jobs.dou.ua/x · empty: —',
    );
  });
});

describe('timing a run', () => {
  it('formats milliseconds, seconds, minutes and hours', () => {
    expect(formatDuration(420)).toBe('420ms');
    expect(formatDuration(4200)).toBe('4.2s');
    expect(formatDuration(184_000)).toBe('3m 04s');
    expect(formatDuration(4_320_000)).toBe('1h 12m');
  });

  it('measures a finished run and a run still in flight', () => {
    expect(runDurationMs(run())).toBe(4200);
    const running = run({ finishedAt: null });
    expect(runDurationMs(running, new Date('2026-09-27T08:00:30.000Z'))).toBe(30_000);
    expect(runDurationMs(run({ startedAt: 'nonsense' }))).toBeNull();
  });

  it('formats the start and summarises a list', () => {
    expect(formatRunStart('2026-09-27T08:00:00.000Z')).not.toBe('');
    expect(formatRunStart('nonsense')).toBe('nonsense');
    expect(summarizeRuns([])).toBe('no runs recorded yet');
    expect(summarizeRuns([run(), run({ id: 2, status: 'failed' })])).toBe('1 ok · 1 failed');
  });
});
