import { coverNeeded } from './cover';
import type { CoverOutcome } from './cover';
import { coverLetter, failCoverRequest, markCoverRequested } from './db';
import { errorMessage } from './http';
import { publishCoverRequests } from './queue';

/**
 * Asking for a cover letter - once, for both callers.
 *
 * The cover-letter page's *Generate* button (`POST /api/cover/<job_id>`) and a move into **Prepare** want
 * the same three steps: claim the row, publish to `resumes.cover`, and mark the row `failed` if
 * the broker refuses (`CONSTITUTION.md` invariant 24). They differ in exactly one thing, and
 * that is the `onlyIfMissing` flag: a click is the operator asking for a letter *now*, so it
 * always regenerates, while a move must not replace a letter that is already written or on its
 * way - the operator may have read it, and a second generation costs a second Gemini call.
 *
 * The order is what makes duplicates impossible: the claim comes first (and it is refused while
 * the row says `running`), so two requests cannot both publish, and the row is only ever left
 * claiming `queued` when something really is on the way. A throw from here is a *store* failure
 * - the caller turns that into its own 503 or, in the move route, into a reported `failed`.
 */
export interface CoverRequestOptions {
  /**
   * True for the automatic request (a move into Prepare): leave an existing letter alone.
   * False (the default) for the page's *Generate*: regenerate, whatever is there.
   */
  onlyIfMissing?: boolean;
}

export interface CoverRequestResult {
  outcome: CoverOutcome;
  /** The broker's own words, so a caller can log it or return it to the operator. */
  error?: string;
}

export async function requestCoverLetter(
  jobId: string,
  options: CoverRequestOptions = {},
): Promise<CoverRequestResult> {
  if (options.onlyIfMissing && !coverNeeded(await coverLetter(jobId))) {
    return { outcome: 'already' };
  }

  if (!(await markCoverRequested(jobId))) {
    return { outcome: 'busy' };
  }

  try {
    await publishCoverRequests([{ job_id: jobId, enqueued_at: new Date().toISOString() }]);
    return { outcome: 'queued' };
  } catch (error) {
    const reason = errorMessage(error);
    await failCoverRequest(jobId, reason).catch(() => undefined);
    return { outcome: 'failed', error: reason };
  }
}
