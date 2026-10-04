import type { APIRoute } from 'astro';
import { fetchProcessRuns } from '../../lib/db';
import { errorMessage, json } from '../../lib/http';

export const prerender = false;

/** How many runs the Processes page asks for. */
const RUN_LIMIT = 100;

/**
 * GET /api/processes - the internal processes' run history, newest first.
 *
 * The rows are the jobs' own (`apps/worker/utils/process_runs.py`): the RSS intake (`feed-parser`) and the
 * inactivity sweep (`auto-archiver`) open one row per run and close it with their counters, so
 * a run that changed nothing is visible too - and a row still `running` means the pod died
 * mid-run (the next run of that job retires it as `aborted`).
 */
export const GET: APIRoute = async () => {
  try {
    return json({ ok: true, runs: await fetchProcessRuns(RUN_LIMIT) });
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, 500);
  }
};
