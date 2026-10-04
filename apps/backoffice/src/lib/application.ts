import { createHash } from 'node:crypto';

/**
 * The contract between the extension's *Populate* button and the `applications.draft` queue.
 *
 * The extension renders the application form it picked into a snapshot: every fillable control
 * carries a `data-cvt-id` **it** minted (`f1`, `f2`, ...), and the HTML is trimmed to the form
 * subtree. The snapshot plus the candidate file's version hash into a `schemaHash`, which is the
 * cache key on the worker side - the same rendered form is answered once, a changed form (or a
 * changed candidate file) is a genuine re-draft.
 *
 * Pure on purpose: a malformed snapshot must be refused *before* it reaches the broker, because
 * the message ends up in a Gemini prompt (and the ids in it are the only way the plan can address
 * a field - `apps/worker/agent/contracts.py::ApplicationDraftMessage` is the Python half of this contract).
 */

export const MAX_FIELDS = 80;
export const MAX_HTML_CHARS = 200_000;
export const MAX_LABEL_CHARS = 500;
export const MAX_NAME_CHARS = 200;
export const MAX_PLACEHOLDER_CHARS = 300;
export const MAX_OPTIONS = 40;
export const MAX_OPTION_CHARS = 200;

/** What the extension mints per control; the pattern matches the Python side's `id` field. */
const FIELD_ID = /^[A-Za-z0-9_-]{1,24}$/;

export interface ApplicationFieldInput {
  id: string;
  kind: string;
  label: string;
  name: string;
  placeholder: string;
  required: boolean;
  hidden: boolean;
  options: string[];
}

export interface ApplicationFormInput {
  root: string;
  html: string;
  fields: ApplicationFieldInput[];
}

export type ApplicationParse =
  | { ok: true; form: ApplicationFormInput; schemaHash: string }
  | { ok: false; error: string };

function asText(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

/**
 * The snapshot's cache key: the form itself plus the candidate file's version, so editing the
 * profile invalidates every plan that was drafted from the old facts.
 *
 * Deterministic by construction - the ids are minted in DOM order, so the same rendered form
 * hashes the same way - which is what lets the worker answer the same form for free.
 */
export function schemaHash(form: ApplicationFormInput, candidateVersion: string): string {
  const canonical = JSON.stringify({
    root: form.root,
    fields: form.fields,
    html: form.html,
    candidate: candidateVersion,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 32);
}

/** Validate a `POST /api/apply/<jobId>` body, or say exactly what is wrong with it. */
export function parseApplicationRequest(
  body: unknown,
  candidateVersion: string,
): ApplicationParse {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const raw = body as { form?: unknown };
  const form = raw.form;
  if (typeof form !== 'object' || form === null || Array.isArray(form)) {
    return { ok: false, error: 'form must be an object' };
  }
  const source = form as { root?: unknown; html?: unknown; fields?: unknown };

  const html = typeof source.html === 'string' ? source.html.trim() : '';
  if (!html) return { ok: false, error: 'form.html is required' };
  if (html.length > MAX_HTML_CHARS) {
    return {
      ok: false,
      error: `form.html is too long (${html.length} > ${MAX_HTML_CHARS} chars)`,
    };
  }

  const items = source.fields;
  if (!Array.isArray(items)) return { ok: false, error: 'form.fields must be an array' };
  if (items.length === 0) {
    return { ok: false, error: 'form.fields is empty - nothing to fill in' };
  }
  if (items.length > MAX_FIELDS) {
    return { ok: false, error: `too many fields (${items.length} > ${MAX_FIELDS})` };
  }

  const seen = new Set<string>();
  const fields: ApplicationFieldInput[] = [];
  for (const [index, item] of items.entries()) {
    if (typeof item !== 'object' || item === null) {
      return { ok: false, error: `form.fields[${index}] must be an object` };
    }
    const field = item as Record<string, unknown>;
    const id = asText(field.id, 24);
    if (!FIELD_ID.test(id)) {
      return { ok: false, error: `form.fields[${index}].id must match ${FIELD_ID}` };
    }
    if (seen.has(id)) return { ok: false, error: `form.fields[${index}].id is duplicated (${id})` };
    seen.add(id);

    const options = Array.isArray(field.options)
      ? field.options
          .slice(0, MAX_OPTIONS)
          .map((option) => asText(option, MAX_OPTION_CHARS))
          .filter(Boolean)
      : [];

    fields.push({
      id,
      kind: asText(field.kind, 32) || 'text',
      label: asText(field.label, MAX_LABEL_CHARS),
      name: asText(field.name, MAX_NAME_CHARS),
      placeholder: asText(field.placeholder, MAX_PLACEHOLDER_CHARS),
      required: field.required === true,
      hidden: field.hidden === true,
      options,
    });
  }

  const parsed: ApplicationFormInput = {
    root: asText(source.root, 500),
    html,
    fields,
  };
  return { ok: true, form: parsed, schemaHash: schemaHash(parsed, candidateVersion) };
}

/** The publish payload: exactly what `apps/worker/agent/contracts.py::ApplicationDraftMessage` validates. */
export function toApplicationMessage(
  form: ApplicationFormInput,
  context: { jobId: string; url: string; host: string; schemaHash: string; attempt?: number },
): Record<string, unknown> {
  return {
    job_id: context.jobId,
    schema_hash: context.schemaHash,
    url: context.url,
    host: context.host,
    form,
    attempt: context.attempt ?? 0,
    enqueued_at: new Date().toISOString(),
  };
}
