import type { ProcessRun } from './types';

/**
 * The Processes page's vocabulary: the slugs the jobs record, their labels, and how a run's
 * counters read as one line.
 *
 * The slugs are the jobs' own (`apps/worker/utils/process_runs.py`, enforced by the `process_runs`
 * CHECK), so a new job adds a slug there and a label here - never a column. An unknown slug
 * still renders (the row is data, the label is presentation), which is what keeps the window
 * honest when a job is deployed before its label is. The same goes for a run's `trigger`: the
 * words are the database's (`schedule`, `manual`, `startup`), so an unknown one is shown as it
 * is instead of being mistaken for a scheduled slot.
 */

export const PROCESS_LABELS: Record<string, { label: string; hint: string }> = {
  'feed-parser': {
    label: 'XML Feed Parser',
    hint: 'python -m scout · RSS feeds -> cards in Scraped',
  },
  'auto-archiver': {
    label: 'AutoArchiver',
    hint: 'python -m archiver · refuses the Applied cards that went quiet',
  },
};

export function processLabel(process: string): string {
  return PROCESS_LABELS[process]?.label ?? process;
}

export function processHint(process: string): string {
  return PROCESS_LABELS[process]?.hint ?? 'an internal process';
}

/**
 * The five statuses, with the chip classes the table uses. The strings are literal so Tailwind
 * can see them, exactly like the stage chips in `stages.ts`.
 */
export const RUN_STATUS: Record<string, { label: string; chip: string }> = {
  running: { label: 'Running', chip: 'bg-sky-100 text-sky-700 ring-sky-200' },
  ok: { label: 'OK', chip: 'bg-emerald-100 text-emerald-700 ring-emerald-200' },
  failed: { label: 'Failed', chip: 'bg-rose-100 text-rose-700 ring-rose-200' },
  skipped: { label: 'Skipped', chip: 'bg-slate-100 text-slate-600 ring-slate-200' },
  aborted: { label: 'Aborted', chip: 'bg-amber-100 text-amber-800 ring-amber-200' },
};

export function runStatus(status: string): { label: string; chip: string } {
  return (
    RUN_STATUS[status] ?? { label: status, chip: 'bg-slate-100 text-slate-600 ring-slate-200' }
  );
}

/** `new_cards` -> `new cards`: the counters are the jobs', the words are the operator's. */
export function humanizeKey(key: string): string {
  return key.replace(/_/g, ' ');
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  return String(value);
}

/**
 * One run's outcome in one line: its counters, or the error that stopped it.
 *
 * The counters are whatever the job reported - the window has no per-job knowledge, so a job
 * that starts reporting a new counter shows it without a UI change. `dry_run` is the one
 * convention: it is a marker, not a count, so it is appended as a word.
 */
export function describeRun(run: ProcessRun): string {
  if (run.error) return run.error;
  const summary = run.summary ?? {};
  const parts = Object.entries(summary)
    .filter(([key]) => key !== 'dry_run')
    .map(([key, value]) => `${humanizeKey(key)}: ${formatValue(value)}`);
  if (summary.dry_run === true) parts.push('dry run');
  return parts.length > 0 ? parts.join(' · ') : 'no counters reported';
}

/**
 * What started this row: `schedule` (a CronJob slot), `manual` (a hand-run), `startup` (the
 * deploy's hook Job), or `dry run` - a `--dry-run` writes no ledger row at all, so the marker is
 * the operator's own, read from the counters the run reported.
 */
export function triggerLabel(run: ProcessRun): string {
  if (run.summary?.dry_run === true) return 'dry run';
  return run.trigger;
}

/** `12.4s`, `3m 04s`, `1h 12m` - how long a run took, or how long it has been running. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** How long a run lasted; a run still in flight is measured against `now`. */
export function runDurationMs(run: ProcessRun, now: Date = new Date()): number | null {
  const started = new Date(run.startedAt).getTime();
  if (Number.isNaN(started)) return null;
  const finished = run.finishedAt ? new Date(run.finishedAt).getTime() : now.getTime();
  if (Number.isNaN(finished)) return null;
  return Math.max(0, finished - started);
}

/** `27 Sep, 09:00` - the Started column. */
export function formatRunStart(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** `3 ok · 1 failed` for the toolbar of the window; unknown statuses are counted as they are. */
export function summarizeRuns(runs: ProcessRun[]): string {
  if (runs.length === 0) return 'no runs recorded yet';
  const counts = new Map<string, number>();
  for (const run of runs) counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
  return [...counts.entries()].map(([status, count]) => `${count} ${status}`).join(' · ');
}
