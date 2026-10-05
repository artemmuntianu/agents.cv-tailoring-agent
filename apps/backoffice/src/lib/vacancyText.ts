import type { ParseResult } from './applyUrl';

/**
 * The **parsed** vacancy text: the page at `/vacancy/<job_id>` and the route behind it.
 *
 * `resumes.description_raw` is the parsed job description - the plain text the scraper's reader (or the
 * scout's feed parser) produced out of the posting, and the text the tailoring prompt is handed. The
 * board deliberately does not carry it: `lib/db.ts::CARD_SELECT` ships `has_description`, because
 * fetching a hundred job descriptions to draw a board would be absurd. So looking at one means asking
 * for one row, which is what this module's callers do.
 *
 * The rules live here, pure, for the reason every other `lib/` module does: the route and the component
 * both need them, and the shape of a parsed description is worth being able to inspect without a
 * database.
 */

/**
 * The `job_id` shape - the same one `resumes_job_id_shape` and the worker's Pydantic field enforce
 * (`CONSTITUTION.md` invariant 4). A URL carries a caller-supplied string, so the route validates it
 * before it reaches a query: the database would refuse it anyway, but a 400 that names the problem beats
 * a 500 that does not.
 */
const JOB_ID = /^[A-Za-z0-9_.:-]{4,80}$/;

export const MAX_JOB_ID_LENGTH = 80;

/** Validate the `job_id` a caller asked about. */
export function parseJobQuery(raw: string | null | undefined): ParseResult<string> {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, error: 'job_id is required' };
  if (text.length > MAX_JOB_ID_LENGTH) {
    return { ok: false, error: `job_id must be at most ${MAX_JOB_ID_LENGTH} characters` };
  }
  if (!JOB_ID.test(text)) {
    return { ok: false, error: 'job_id must be an opaque row id (letters, digits, _ . : -)' };
  }
  return { ok: true, value: text };
}

export interface TextStats {
  chars: number;
  lines: number;
  words: number;
}

/**
 * How much text the prompt is about to be given.
 *
 * These counts are how a parse that "worked" but produced almost nothing gets caught: a description
 * that parses to one line looks perfectly fine on a card, and ruins a tailored CV. `lines` counts
 * non-blank ones, because that is what the reader emits between paragraphs.
 *
 * A missing text (`null` - a row created before the column existed, 2026-09-26) counts as zero of
 * everything rather than throwing: the caller shows the reason, not a crash.
 */
export function textStats(text: string | null | undefined): TextStats {
  const value = typeof text === 'string' ? text : '';
  if (!value) return { chars: 0, lines: 0, words: 0 };
  return {
    chars: value.length,
    lines: value.split('\n').filter((line) => line.trim().length > 0).length,
    words: value.split(/\s+/).filter(Boolean).length,
  };
}

/**
 * The one line a page (or a test) can show about a text - including the empty case, which is a fact
 * worth stating rather than a blank space.
 */
export function describeText(text: string | null | undefined): string {
  const stats = textStats(text);
  if (stats.chars === 0) return 'no parsed text on this row';
  return `${stats.chars} characters · ${stats.lines} lines · ${stats.words} words`;
}
