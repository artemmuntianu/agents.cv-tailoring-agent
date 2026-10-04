import type { BoardCard } from './types';

/**
 * The fields the Move dialog offers to fill in when the **scrape left them empty** - the
 * dialog's *Missing fields* section.
 *
 * A list on purpose: the section renders whatever `missingFields` returns, so the next scraped
 * field that can come back blank (a hidden employer, a bare title) is one entry here, one key on
 * the request, and nothing else. Pure, like the rest of the dialog's decisions.
 */
export interface MissingField {
  /** The request key it lands in (`MoveRequest.company`). */
  key: 'company';
  label: string;
  placeholder: string;
  /** The input's own cap - the same limit the request parser enforces. */
  maxLength: number;
  /** Why the field matters, shown under the input. */
  hint: string;
}

/** `resumes.company` is free text; the scrape caps its own fields the same way (`lib/vacancies.ts`). */
export const MAX_COMPANY_LENGTH = 300;

export const COMPANY_FIELD: MissingField = {
  key: 'company',
  label: 'Company',
  placeholder: 'e.g. Binariks',
  maxLength: MAX_COMPANY_LENGTH,
  hint: 'Saved on the card with the move: the tailoring prompt and the cover letter both read it.',
};

/** Which fields this card is missing - an empty section for a card that has everything. */
export function missingFields(card: Pick<BoardCard, 'company'>): MissingField[] {
  return (card.company || '').trim() ? [] : [COMPANY_FIELD];
}

/** The request fragment the dialog's values become: collapsed, trimmed, and empties dropped. */
export function missingRequest(values: Record<string, string> | undefined): { company?: string } {
  const company = clean(values?.company);
  return company ? { company } : {};
}

export interface CompanyFill {
  /** What the company is after the move. */
  company: string;
  /** What this request has to write, or `null` when the stored value already stands. */
  fill: string | null;
}

/**
 * Resolve one move's company: **the stored value wins**, and the typed one only ever fills a
 * blank. Both halves come from one look, so the value the route writes to `resumes.company` is the
 * same one it puts in the published message - re-reading the row would be a second guess, and the
 * message would carry the blank the operator just filled.
 */
export function resolveCompany(
  stored: string | null | undefined,
  typed: string | null | undefined,
): CompanyFill {
  const current = clean(stored);
  if (current) return { company: current, fill: null };
  const value = clean(typed);
  return value ? { company: value, fill: value } : { company: '', fill: null };
}

function clean(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_COMPANY_LENGTH);
}
