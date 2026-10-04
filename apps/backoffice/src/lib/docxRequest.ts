import { failDocxUpdateRequest, markDocxUpdateRequested } from './db';
import { errorMessage } from './http';
import { publishRerenderRequests } from './queue';

/**
 * Asking for a re-render of a hand-edited deliverable - once, for the modal.
 *
 * The same three steps as the cover letter (`lib/coverRequest.ts`), with one difference that
 * matters: here the upload *is* the request, so the bytes are stored by the claim itself. A claim
 * that is refused (a render already running for this card) therefore leaves nothing behind - two
 * clicks cannot replace the bytes a conversion is already reading.
 *
 * A throw from here is a *store* failure and the caller turns it into a 503; a `failed` outcome
 * means the broker refused the publish, and the row no longer claims a render is on its way.
 */
export interface DocxRequestResult {
  outcome: 'queued' | 'busy' | 'failed';
  /** The broker's own words, so the caller can log it or return it to the operator. */
  error?: string;
}

export async function requestDocxRerender(
  jobId: string,
  upload: { filename: string; content: Uint8Array },
): Promise<DocxRequestResult> {
  if (!(await markDocxUpdateRequested(jobId, upload.filename, upload.content))) {
    return { outcome: 'busy' };
  }

  try {
    await publishRerenderRequests([{ job_id: jobId, enqueued_at: new Date().toISOString() }]);
    return { outcome: 'queued' };
  } catch (error) {
    const reason = errorMessage(error);
    await failDocxUpdateRequest(jobId, reason).catch(() => undefined);
    return { outcome: 'failed', error: reason };
  }
}
