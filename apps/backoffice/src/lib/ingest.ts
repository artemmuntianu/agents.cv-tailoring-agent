import type { ScrapedVacancy } from './vacancies';

/**
 * The status the intake writes when it creates a vacancy's card (`resumes.status`).
 *
 * The row *is* the card. It sits in the board's **Scraped** column until the operator drags
 * it to Prepare - that drag is what publishes the tailoring message
 * (`pages/api/board/move.ts`), so scraping a page costs no Gemini request at all.
 *
 * It MUST stay outside `apps/worker/utils/db.py::ACTIVE_STATUSES`. The worker's claim looks the vacancy
 * up by business key (`user_id` + `source` + `external_id` + `cv_version`) and treats an
 * *active* sibling as a duplicate delivery - which would ack the message without doing the
 * work. A non-active status is re-claimed instead: the worker updates **that** row (same
 * `job_id`) and runs, so the card the intake created is the card that goes
 * `submitted -> processing -> completed`.
 *
 * `apps/worker/tests/test_postgres_store.py` pins both halves of that contract.
 */
export const INGEST_STATUS = 'submitted';

/** The part of an existing `resumes`/`resume_board` row the ingest decision needs. */
export interface ExistingVacancy {
  jobId: string;
  status: string;
  /** ISO timestamp of `resumes.updated_at`. */
  updatedAt: string;
  /** `resume_board.archived_at is not null` - the operator has refused this vacancy. */
  archived: boolean;
}

export interface InsertPlan {
  jobId: string;
  vacancy: ScrapedVacancy;
}

export interface IngestPlan {
  /** Rows to create - the cards that appear in Scraped. */
  insert: InsertPlan[];
  /** Vacancies the board already knows, whatever their status (refused ones included). */
  duplicates: number;
}

/**
 * Decide what one batch does, given what the board already has.
 *
 * Pure on purpose: the rule "a card the operator can see is never created twice" is worth a
 * test, and the API route should not be the first thing to notice that a re-scrape of the same
 * listing would fork a second card for one vacancy (`resumes_job_key_idx` allows only one row
 * per user + site + vacancy + CV version anyway).
 *
 * Creating cards is *all* a batch does. There is deliberately no `publish`/`retry` half any
 * more: entering Prepare is the operator's instruction to tailor, so neither a browser page
 * nor the scheduled scout can spend the Gemini budget on its own.
 */
export function planIngest(
  vacancies: ScrapedVacancy[],
  existing: Map<string, ExistingVacancy>,
  options: { makeJobId: () => string },
): IngestPlan {
  const plan: IngestPlan = { insert: [], duplicates: 0 };

  for (const vacancy of vacancies) {
    // One card per vacancy - including a card the operator *refused*: scraping a page again
    // is not an instruction to reopen a closed application, and a card already in Scraped
    // must not be forked while it waits for a decision.
    if (existing.has(vacancy.external_id)) {
      plan.duplicates += 1;
      continue;
    }
    plan.insert.push({ jobId: options.makeJobId(), vacancy });
  }

  return plan;
}
