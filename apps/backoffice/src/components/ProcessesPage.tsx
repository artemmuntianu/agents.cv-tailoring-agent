import { useCallback, useEffect, useState } from 'react';
import AppShell from './AppShell';
import ProcessRunTable from './ProcessRunTable';
import { summarizeRuns } from '../lib/processes';
import type { ProcessRun } from '../lib/types';

interface ProcessesPageProps {
  session: { email: string; name: string | null; admin: boolean };
}

/**
 * `/processes` - the internal jobs' run log, a **page** rather than a window over the board.
 *
 * It is a page for the same reason `/admin` is: the panel and the header are the application's
 * chrome, and a modal hides them (and the operator's place in the app) for as long as it is
 * open. The data is `GET /api/processes` (`process_runs`, newest first, written by the scheduled
 * jobs through `apps/worker/utils/process_runs.py`), read when the page loads and on demand - never polled:
 * a run log is something the operator looks at, and the board's 5s cadence would say nothing new
 * for hours.
 */
export default function ProcessesPage({ session }: ProcessesPageProps) {
  const [runs, setRuns] = useState<ProcessRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/processes');
      if (response.status === 401) {
        // The 8h session expired; the login page sends us back here afterwards.
        window.location.assign('/login?next=/processes');
        return;
      }
      const payload = (await response.json()) as {
        ok: boolean;
        runs?: ProcessRun[];
        error?: string;
      };
      if (!response.ok || !payload.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setRuns(payload.runs ?? []);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <AppShell
      active="processes"
      title="Internal processes"
      subtitle={`Every run of the scheduled jobs, newest first · ${summarizeRuns(runs)}`}
      session={session}
      actions={
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:text-slate-400"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      }
    >
      {error && (
        <p className="mb-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </p>
      )}

      <ProcessRunTable runs={runs} loading={loading} />

      <p className="mt-4 text-[11px] leading-relaxed text-slate-400">
        A run that found nothing still leaves a row. A row stuck on <em>running</em> means the pod
        died mid-run; the next run of that job marks it <em>aborted</em>.
      </p>
    </AppShell>
  );
}
