import type { APIRoute } from 'astro';
import { taskMessageRow } from '../../../../lib/db';
import { requestDocxRerender } from '../../../../lib/docxRequest';
import type { DocxRequestResult } from '../../../../lib/docxRequest';
import { safeFilename, uploadRejection } from '../../../../lib/docxUpload';
import { errorMessage, json } from '../../../../lib/http';
import { rerenderQueueName } from '../../../../lib/queue';

export const prerender = false;

const JOB_ID = /^[A-Za-z0-9_.:-]{4,80}$/;

/**
 * POST /api/board/docx/<job_id> - "this card's document changed, rebuild its PDF".
 *
 * The board's *Update docx* button. The operator downloads the tailored DOCX, verifies it, edits
 * what the model could not, and uploads the result here; `rerender.py` then writes that file back
 * as the card's deliverable and converts it to a new PDF, so the *Tailored PDF* / *Tailored DOCX*
 * links the modal already offers simply point at the new pair.
 *
 * Offered only for a card that **went through tailoring** (it has a `docx_path`) and refused with
 * 409 otherwise: replacing a deliverable that does not exist is not a render, it is a card that
 * never had one - and the worker refuses the same way, because a route is not a guarantee.
 *
 * The upload travels as `multipart/form-data` with one `file` part, and its bytes are stored by the
 * claim itself (`lib/docxRequest.ts`), so a refused claim leaves no orphan upload behind.
 */
export const POST: APIRoute = async ({ params, request, locals }) => {
  const session = locals.session;
  if (!session) return json({ ok: false, error: 'authentication required' }, 401);

  const jobId = String(params.jobId ?? '').trim();
  if (!JOB_ID.test(jobId)) {
    return json({ ok: false, error: 'invalid job_id' }, 400);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch (error) {
    return json({ ok: false, error: `could not read the upload: ${errorMessage(error)}` }, 400);
  }

  const part = form.get('file');
  if (!part || typeof part === 'string') {
    return json({ ok: false, error: 'no file was uploaded (form field "file")' }, 400);
  }

  const filename = safeFilename(part.name);
  const content = new Uint8Array(await part.arrayBuffer());
  const rejection = uploadRejection(filename, content);
  if (rejection) return json({ ok: false, error: rejection }, 400);

  let row;
  try {
    row = await taskMessageRow(jobId);
  } catch (error) {
    return json({ ok: false, error: `job store unavailable: ${errorMessage(error)}` }, 503);
  }
  if (!row) return json({ ok: false, error: `no vacancy with job_id ${jobId}` }, 404);
  if (!row.docxPath) {
    return json(
      {
        ok: false,
        error:
          'this card has no tailored document yet - the *Update docx* button appears once ' +
          'tailoring has produced one',
      },
      409,
    );
  }

  let result: DocxRequestResult;
  try {
    result = await requestDocxRerender(jobId, { filename, content });
  } catch (error) {
    return json({ ok: false, error: `job store unavailable: ${errorMessage(error)}` }, 503);
  }

  if (result.outcome === 'busy') {
    return json(
      { ok: false, error: 'this document is already being re-rendered' },
      409,
    );
  }
  if (result.outcome === 'failed') {
    return json({ ok: false, error: result.error ?? 'the publish failed' }, 502);
  }
  return json({
    ok: true,
    published: 1,
    queue: rerenderQueueName(),
    filename,
    sizeBytes: content.length,
  });
};
