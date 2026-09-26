import { tailoringFromStatus } from './stages';
import type { ScrapedVacancy } from './vacancies';

/**
 * The status the gateway writes when it creates a vacancy's row *before* the
 * worker's claim, so the card is on the board the moment the scrape finishes instead
 * of only after KEDA boots a worker.
 *
 * It MUST stay outside `utils/db.py::ACTIVE_STATUSES`. The worker's claim looks the
 * vacancy up by business key (`user_id` + `external_id` + `cv_version`) and treats an
 * *active* sibling as a duplicate delivery - which would ack the message without
 * doing the work. A non-active status is re-claimed instead: the worker updates
 * **that** row (same `job_id`) and runs, so the card the gateway created is the card
 * that goes `submitted -> processing -> completed`.
 *
 * `tests/test_postgres_store.py` pins both halves of that contract.
 */
export const INGEST_STATUS = 'submitted';

/**
 * How long a `submitted` row may sit unclaimed before a re-scrape re-queues it. The
 * gateway commits the row before publishing, so a crash/browser-tab-kill in between
 * leaves a card with no message; after this window the next scrape republishes it
 * (the worker adopts the same row again - it never re-inserts).
 */
export const STALE_INGEST_MS = 15 * 60 * 1000;

/** The part of an existing `resumes`/`resume_board` row the ingest decision needs. */
export interface ExistingVacancy {
  jobId: string;
  status: string;
  /** ISO timestamp of `resumes.updated_at`. */
  updatedAt: string;
  /** `resume_board.archived_at is not null` - the operator has refused this vacancy. */
  archived: boolean;
}

export interface PublishPlan {
  vacancy: ScrapedVacancy;
  jobId: string;
  /** True when an existing failed/stale row is re-queued under its own job_id. */
  retry: boolean;
}

export interface InsertPlan {
  jobId: string;
  vacancy: ScrapedVacancy;
}

export interface IngestPlan {
  /** Messages to publish, in board order. */
  publish: PublishPlan[];
  /** Rows to create before publishing (the cards that must appear immediately). */
  insert: InsertPlan[];
  /** Vacancies the board already knows and that are in flight or done. */
  duplicates: number;
  /** Failed (or abandoned) cards re-queued under their existing job_id. */
  retries: number;
}

/**
 * Decide what one batch does, given what the board already has.
 *
 * Pure on purpose: the rule "a card the operator can see is never queued twice" is
 * worth a test, and the API route should not be the first thing to notice that a
 * re-scrape of the same listing would fork a second card for one vacancy
 * (`resumes_job_key_idx` allows only one row per user + vacancy + CV version anyway).
 */
export function planIngest(
  vacancies: ScrapedVacancy[],
  existing: Map<string, ExistingVacancy>,
  options: { makeJobId: () => string; now?: Date },
): IngestPlan {
  const now = (options.now ?? new Date()).getTime();
  const plan: IngestPlan = { publish: [], insert: [], duplicates: 0, retries: 0 };

  for (const vacancy of vacancies) {
    const known = existing.get(vacancy.external_id);

    if (known?.archived) {
      // A refused vacancy stays refused. Without this the flow above would happily
      // re-queue a card the operator archived precisely because it failed - scraping a
      // page again is not an instruction to reopen closed applications.
      plan.duplicates += 1;
      continue;
    }

    if (!known) {
      const jobId = options.makeJobId();
      plan.insert.push({ jobId, vacancy });
      plan.publish.push({ vacancy, jobId, retry: false });
      continue;
    }

    // Only a card whose derived state is "Tailoring Failed", or one the gateway
    // created and whose message never confirmed, starts a new attempt - and it keeps
    // its job_id, because the board card *is* that row.
    const failed = tailoringFromStatus(known.status) === 'failed';
    const abandoned =
      known.status === INGEST_STATUS && now - new Date(known.updatedAt).getTime() > STALE_INGEST_MS;

    if (failed || abandoned) {
      plan.retries += 1;
      plan.publish.push({ vacancy, jobId: known.jobId, retry: true });
      continue;
    }

    plan.duplicates += 1;
  }

  return plan;
}
