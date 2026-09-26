import type { APIRoute } from 'astro';
import { deleteArtifact } from '../../../lib/artifacts';
import { isRemovableStatus, parseRemoveRequest } from '../../../lib/board';
import { cardForRemoval, purgeCard, queueArtifactPurge } from '../../../lib/db';
import { errorMessage, json } from '../../../lib/http';

export const prerender = false;

/**
 * POST /api/board/remove - delete a refused vacancy for good.
 *
 * The only irreversible action on the board, so it is deliberately narrow:
 *
 *   1. the card must be **archived** (archiving is the reversible step, removal is not);
 *   2. no worker may own the vacancy (`REMOVABLE_STATUSES`) - a task that finished after the
 *      purge would leave its artifacts behind with nothing pointing at them;
 *   3. the artifact files this board can reach are deleted first, and every stored path it
 *      cannot (`mirror-only`/`absent` - the cluster volume on a dev machine) is queued in
 *      `artifact_purge` for `scripts/storage-files.ps1 -Action purge`;
 *   4. last, the row itself: `resumes`, with `resume_board` and the whole `resume_history`
 *      cascade.
 *
 * Nothing is tombstoned: the vacancy becomes unknown to the system again, so re-scraping its
 * page creates a fresh card - and pays for tailoring again.
 */
export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'body must be JSON' }, 400);
  }

  const parsed = parseRemoveRequest(body);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);

  try {
    const card = await cardForRemoval(parsed.value.jobId);
    if (!card) {
      return json({ ok: false, error: `no vacancy with job_id ${parsed.value.jobId}` }, 404);
    }
    if (!card.archived) {
      return json({ ok: false, error: 'archive the vacancy first - removal cannot be undone' }, 409);
    }
    if (!isRemovableStatus(card.status)) {
      return json(
        { ok: false, error: `the worker still owns this vacancy (status: ${card.status})` },
        409,
      );
    }

    const stored = [card.pdfUrl, card.docxPath].filter((path): path is string => Boolean(path));
    const removed: string[] = [];
    const queued: string[] = [];
    for (const path of stored) {
      const outcome = await deleteArtifact(path);
      if (outcome === 'removed') removed.push(path);
      else queued.push(path); // 'mirror-only' included: a mirror is not the volume
    }
    await queueArtifactPurge(parsed.value.jobId, queued);

    const purged = await purgeCard(parsed.value.jobId);
    if (!purged) {
      return json({ ok: false, error: `no vacancy with job_id ${parsed.value.jobId}` }, 404);
    }

    return json({
      ok: true,
      jobId: parsed.value.jobId,
      purged: true,
      removed,
      queued,
      note:
        queued.length > 0
          ? 'the files that live on the cluster volume are queued: run .\\scripts\\storage-files.ps1 -Action purge'
          : 'nothing was left behind on the volume',
    });
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, 500);
  }
};
