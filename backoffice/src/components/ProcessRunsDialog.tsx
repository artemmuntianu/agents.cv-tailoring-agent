import { useEffect } from 'react';
import {
  describeRun,
  formatDuration,
  formatRunStart,
  processHint,
  processLabel,
  runDurationMs,
  runStatus,
  summarizeRuns,
} from '../lib/processes';
import type { ProcessRun } from '../lib/types';

interface ProcessRunsDialogProps {
  runs: ProcessRun[];
  loading: boolean;
  error: string | null;
  onReload: () => void;
  onClose: () => void;
}

/** `schedule`, `manual`, `dry run` - what started this row. */
function triggerLabel(run: ProcessRun): string {
  if (run.summary?.dry_run === true) return 'dry run';
  return run.trigger === 'manual' ? 'manual' : 'schedule';
}

/**
 * The navbar's **Processes** window: the run history of the internal jobs in a table.
 *
 * The rows are the jobs' own (`utils/process_runs.py`): the RSS intake (`feed-parser`, twice an
 * hour) and the inactivity sweep (`auto-archiver`, daily) open a row when they start and close
 * it with their counters - so a run that found nothing is visible, and a row still `running`
 * after a day means the pod died and the next run retired it as `aborted`.
 *
 * The window has no per-job knowledge: a counter a job starts reporting shows up by itself, and
 * a slug without a label still renders (the label is presentation, the row is data). It closes
 * on Escape and on a click on the overlay, like every other dialog here.
 */
export default function ProcessRunsDialog({
  runs,
  loading,
  error,
  onReload,
  onClose,
}: ProcessRunsDialogProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-slate-900/40 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-4xl flex-col rounded-xl bg-white shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Internal processes</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Every run of the scheduled jobs, newest first · {summarizeRuns(runs)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onReload}
              disabled={loading}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:text-slate-400"
            >
              {loading ? 'Loading…' : 'Refresh'}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-md border border-slate-300 px-2 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-50"
            >
              ✕
            </button>
          </div>
        </header>

        {error && (
          <p className="border-b border-rose-200 bg-rose-50 px-5 py-2 text-sm text-rose-700">
            {error}
          </p>
        )}


        <div className="min-h-0 flex-1 overflow-auto">
          {runs.length === 0 && !loading && !error ? (
            <p className="px-5 py-6 text-sm text-slate-500">
              No runs recorded yet. The rows appear as the scheduled jobs run: the feed parser
              twice an hour, the auto-archiver once a day.
            </p>
          ) : (
            <table className="w-full border-collapse text-left text-sm">
              <thead className="sticky top-0 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-semibold">Process</th>
                  <th className="px-4 py-2 font-semibold">Started</th>
                  <th className="px-4 py-2 font-semibold">Duration</th>
                  <th className="px-4 py-2 font-semibold">Status</th>
                  <th className="px-4 py-2 font-semibold">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {runs.map((run) => {
                  const status = runStatus(run.status);
                  const duration = runDurationMs(run);
                  return (
                    <tr key={run.id} className="align-top hover:bg-slate-50/60">
                      <td className="px-4 py-2">
                        <span className="font-medium text-slate-800">
                          {processLabel(run.process)}
                        </span>
                        <span className="mt-0.5 block text-[11px] text-slate-400">
                          {processHint(run.process)}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-slate-700">
                        {formatRunStart(run.startedAt)}
                        <span className="mt-0.5 block text-[11px] uppercase tracking-wide text-slate-400">
                          {triggerLabel(run)}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-slate-700">
                        {duration === null ? '—' : formatDuration(duration)}
                        {run.finishedAt === null && (
                          <span className="mt-0.5 block text-[11px] text-slate-400">
                            still running
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ${status.chip}`}
                        >
                          {status.label}
                        </span>
                      </td>
                      <td
                        className={`px-4 py-2 ${run.error ? 'text-rose-700' : 'text-slate-600'}`}
                      >
                        {describeRun(run)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <footer className="border-t border-slate-200 px-5 py-3 text-[11px] leading-relaxed text-slate-400">
          A run that found nothing still leaves a row. A row stuck on <em>running</em> means the
          pod died mid-run; the next run of that job marks it <em>aborted</em>.
        </footer>
      </div>
    </div>
  );
}
