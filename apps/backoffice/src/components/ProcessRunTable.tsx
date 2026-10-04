import {
  describeRun,
  formatDuration,
  formatRunStart,
  processHint,
  processLabel,
  runDurationMs,
  runStatus,
  triggerLabel,
} from '../lib/processes';
import type { ProcessRun } from '../lib/types';

interface ProcessRunTableProps {
  runs: ProcessRun[];
  loading: boolean;
}

/**
 * The run log's table - the one thing the Processes *page* draws.
 *
 * The rows are the jobs' own (`apps/worker/utils/process_runs.py`): the RSS intake (`feed-parser`, at deploy
 * time and then twice an hour) and the inactivity sweep (`auto-archiver`, daily) open a row when
 * they start and close it with their counters - so a run that found nothing is visible, and a row
 * still `running` after a day means the pod died and the next run retired it as `aborted`.
 *
 * The table has no per-job knowledge: a counter a job starts reporting shows up by itself, and a
 * slug without a label still renders (the label is presentation, the row is data). Presentation
 * only, on purpose - the fetch, the error banner and the header belong to the page.
 */
export default function ProcessRunTable({ runs, loading }: ProcessRunTableProps) {
  if (runs.length === 0) {
    return (
      <p className="rounded-xl border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
        {loading
          ? 'Loading…'
          : 'No runs recorded yet. The rows appear as the jobs run: the feed parser at deploy ' +
            'time and then twice an hour, the auto-archiver once a day.'}
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
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
                  <span className="font-medium text-slate-800">{processLabel(run.process)}</span>
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
                    <span className="mt-0.5 block text-[11px] text-slate-400">still running</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-2">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ${status.chip}`}
                  >
                    {status.label}
                  </span>
                </td>
                <td className={`px-4 py-2 ${run.error ? 'text-rose-700' : 'text-slate-600'}`}>
                  {describeRun(run)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
