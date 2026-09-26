"""Card creation - the scout's entire output is rows in the board's Scraped column.

Nothing is queued here: the operator's drag into Prepare publishes the tailoring message
(`CONSTITUTION.md` invariant 23), so a run costs no Gemini request no matter how many vacancies
it finds. Two rules come from the store, and both are load-bearing:

* the dedupe is **board-scoped** (`find_existing_ids`): any owner, any status, refused cards
  included - because the board renders every row, so a card the operator can see must not be
  created twice (invariant 17);
* the row is created with `status = 'submitted'`, which is deliberately outside
  `ACTIVE_STATUSES`, so the worker's claim later *adopts* this row instead of acking the drag's
  message as a duplicate.
"""

from agent.contracts import JobStatus
from utils import db as db_module
from utils.db import new_job_id
from utils.logging_setup import get_logger

log = get_logger(__name__)


def new_vacancies(vacancies, source, cv_version, store=None) -> list[dict]:
    """The subset of `vacancies` the board does not have yet, in feed order."""
    store = store or db_module.get_db()
    if not vacancies:
        return []
    known = store.find_existing_ids(
        source, [vacancy["external_id"] for vacancy in vacancies], cv_version
    )
    fresh = [vacancy for vacancy in vacancies if vacancy["external_id"] not in known]
    log.info(
        "dedupe against the board",
        source=source,
        found=len(vacancies),
        already_known=len(vacancies) - len(fresh),
        new=len(fresh),
    )
    return fresh


def create_cards(vacancies, source, user_id, cv_version, store=None) -> list[dict]:
    """Insert one card per vacancy; returns `{job_id, vacancy}` for the rows it really made.

    `upsert_job` is the store's claim API, and it is used here for its *insert* half: it is the
    only method that writes a `resumes` row, it enforces the business key, and it reports
    `duplicate` when a concurrent run of the scout got there first - which is exactly the
    answer an intake needs.
    """
    store = store or db_module.get_db()
    created: list[dict] = []
    for vacancy in vacancies:
        job_id = new_job_id()
        result = store.upsert_job(
            {
                "job_id": job_id,
                "user_id": user_id or None,
                "external_id": vacancy["external_id"],
                "source": source,
                "title": vacancy.get("title") or "",
                "company": vacancy.get("company") or "",
                "source_url": vacancy.get("source_url"),
                "description_raw": vacancy.get("description_raw"),
                "cv_version": cv_version,
                "status": JobStatus.SUBMITTED,
                "attempts": 0,
            }
        )
        outcome = (result or {}).get("outcome", "claimed")
        if outcome != "claimed":
            log.info(
                "another intake got there first",
                external_id=vacancy["external_id"],
                outcome=outcome,
            )
            continue
        created.append({"job_id": (result or {}).get("job_id") or job_id, "vacancy": vacancy})
    return created
