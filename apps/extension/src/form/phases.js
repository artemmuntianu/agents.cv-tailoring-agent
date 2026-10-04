/**
 * The progress vocabulary of one **Populate** run.
 *
 * The flow itself lives in the service worker (`form/worker.js`) and takes a minute or so - a KEDA
 * cold start for the queue pod, one Gemini call, two document fetches - while the popup can only
 * show one line of text. So the worker records *which step it is in* and the popup polls it
 * (`{ type: 'phase' }`, see `background.js`); this module is the wording, and it is pure so the
 * exact strings can be unit tested.
 *
 * The elapsed time is **derived** from `startedAt`, never stored: the popup ticks once a second and
 * a step that takes 20 s has to look like it is moving.
 */

/** Every step, in order. `idle` means no run has happened since the worker started. */
export const PHASE_STEPS = [
  'idle',
  'snapshot',
  'board',
  'drafting',
  'documents',
  'applying',
  'done',
  'failed',
];

/**
 * While the draft is being written the popup follows the **board's own** status (the poll's
 * `status`), because that is the part the extension cannot see: a `queued` row is waiting for KEDA
 * to start a pod, a `running` one is inside the model call.
 */
const DRAFTING = {
  none: 'Queued on the board - waiting for a worker pod…',
  queued: 'Queued on the board - waiting for a worker pod…',
  running: 'Drafting with Gemini…',
};

/** One line for the popup's status area. `now` is injectable so the ticking is testable. */
export function phaseLabel(phase, now = Date.now()) {
  const record = phase && typeof phase === 'object' ? phase : {};
  const step = PHASE_STEPS.includes(record.step) ? record.step : 'idle';
  const seconds = elapsedSeconds(record, now);
  const suffix = seconds >= 2 ? ` (${seconds}s)` : '';

  switch (step) {
    case 'snapshot':
      return `Snapshotting the form…${suffix}`;
    case 'board':
      return `Sending the snapshot to the board…${suffix}`;
    case 'drafting':
      return `${DRAFTING[record.status] || 'Waiting for the draft…'}${suffix}`;
    case 'documents':
      return `Fetching the cover letter and the tailored resume…${suffix}`;
    case 'applying':
      return `Filling the form…${suffix}`;
    case 'done':
      return `Filled in ${seconds}s.`;
    case 'failed':
      return record.error ? `Populate failed: ${record.error}` : 'Populate failed.';
    default:
      return 'Populate is not running.';
  }
}

/** Whole seconds since the run started - the current step does not reset the clock. */
function elapsedSeconds(phase, now) {
  const startedAt = Number(phase.startedAt);
  if (!Number.isFinite(startedAt) || startedAt <= 0) return 0;
  const current = Number(now);
  return Math.max(0, Math.round(((Number.isFinite(current) ? current : Date.now()) - startedAt) / 1000));
}
