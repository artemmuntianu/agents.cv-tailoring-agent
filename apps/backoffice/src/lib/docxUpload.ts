/**
 * The board's half of the *Update docx* workflow: what counts as a document we may send on.
 *
 * In workflow terms the operator downloads the tailored DOCX, verifies it, fixes what the model
 * could not, and uploads it back - the worker then rebuilds the card's PDF from that file. The
 * rules live here, pure, so they are unit tested without a request, a database or a broker.
 *
 * `MAX_DOCX_UPLOAD_BYTES` mirrors `config.py` on purpose: the board refuses early with a readable
 * message, and the worker refuses *again* with the same number, because a client-side check is a
 * convenience rather than a guarantee. The ZIP signature is what tells a DOCX apart from the file
 * an operator picked by mistake; whether the DOCX is *renderable* is LibreOffice's call on the
 * cluster side (`rerender.py`), not something a header can promise.
 */

/** Mirrors `config.py::MAX_DOCX_UPLOAD_BYTES`. */
export const MAX_DOCX_UPLOAD_BYTES = 20 * 1024 * 1024;

export interface DocxUpload {
  filename: string;
  content: Uint8Array;
}

/** A `.docx` is a ZIP container, so it starts with the ZIP local-file signature (`PK`). */
export function looksLikeDocx(content: Uint8Array): boolean {
  return content.length >= 4 && content[0] === 0x50 && content[1] === 0x4b;
}

/**
 * Why this upload cannot be accepted, or `null` when it can.
 *
 * Split in two on purpose: the modal only knows the name and the size (reading a megabyte of
 * bytes to check a header would be silly), while the route has the content and adds the DOCX
 * check on top. Both call `fileRejection`, so the two ends cannot drift apart.
 */
export function fileRejection(filename: string, sizeBytes: number): string | null {
  const name = String(filename || '').trim();
  if (!name) {
    return 'no file was chosen';
  }
  if (!/\.docx$/i.test(name)) {
    return 'upload the DOCX itself - the PDF is regenerated from it, not uploaded';
  }
  if (sizeBytes <= 0) {
    return 'the uploaded file is empty';
  }
  if (sizeBytes > MAX_DOCX_UPLOAD_BYTES) {
    const megabytes = Math.round(MAX_DOCX_UPLOAD_BYTES / (1024 * 1024));
    return `the file is larger than ${megabytes} MB`;
  }
  return null;
}

/** The whole check, for the side that holds the bytes (the route). */
export function uploadRejection(filename: string, content: Uint8Array): string | null {
  const basic = fileRejection(filename, content.length);
  if (basic) {
    return basic;
  }
  if (!looksLikeDocx(content)) {
    return 'that file is not a DOCX (a .docx is a ZIP container, so it starts with PK)';
  }
  return null;
}

/** The name to keep in the row and show in the modal: never a path, never a surprise. */
export function safeFilename(raw: string): string {
  const base = String(raw || '')
    .split(/[\\/]/)
    .pop() ?? '';
  const cleaned = base.replace(/[^\w.\- ]+/g, '_').trim().slice(0, 120);
  return cleaned || 'deliverable.docx';
}

/** The five states the modal shows for a card's deliverable (a missing row is `absent`). */
export type DocxRenderState = 'absent' | 'queued' | 'running' | 'completed' | 'failed';

export function renderState(row: { status: string } | null | undefined): DocxRenderState {
  const status = String(row?.status || '').trim().toLowerCase();
  if (status === 'queued' || status === 'running' || status === 'completed' || status === 'failed') {
    return status;
  }
  return 'absent';
}

export const RENDER_STATE_LABEL: Record<DocxRenderState, string> = {
  absent: 'not updated yet',
  queued: 'uploaded',
  running: 'rendering',
  completed: 'PDF regenerated',
  failed: 'render failed',
};
