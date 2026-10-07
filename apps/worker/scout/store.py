"""Card creation - the scout's entire output is rows in the board's Scraped column.

Nothing is queued here: the operator's drag into Prepare publishes the tailoring message
(`CONSTITUTION.md` invariant 23), so a run costs no Gemini request no matter how many vacancies
it finds. Two rules come from the store, and both are load-bearing:

* the dedupe is **board-scoped** (`find_existing_ids`): any owner, any status, **any master-CV
  version**, refused cards included - because the board renders every row, so a card the operator
  can see must not be created twice (invariant 17). The version is not part of the question: the
  intake publishes `v1` whatever the board holds, so a card re-tailored against a newer master
  used to look *new* and get a `v1` twin (live 2026-10-07);
* the dedupe is also **per site**: the source slug comes from the feed's parser, and it is half of
  the business key, so DOU's and Djinni's rows never see each other's ids;
* the row is created with `status = 'submitted'`, which is deliberately outside
  `ACTIVE_STATUSES`, so the worker's claim later *adopts* this row instead of acking the drag's
  message as a duplicate.
"""

from agent.contracts import JobStatus
from utils import db as db_module
from utils.db import new_job_id
from utils.logging_setup import get_logger

log = get_logger(__name__)


def new_vacancies(vacancies, store=None) -> list[dict]:
    """The subset of `vacancies` the board does not have yet, in feed order.

    The dedupe is per **site** (`find_existing_ids`), because the source is half of the business key
    (`resumes_job_key_idx`): a board that already has Djinni's 374708 has nothing to say about DOU's
    374708. That is why the ids are grouped and asked about one source at a time - and why the
    answer is filtered against the original list instead of concatenated, so the run keeps feed
    order.

    The master-CV version is *not* part of the question, because this run has no version of its
    own: it publishes `CV_VERSION` for whatever it creates, and asking "does the board have this
    vacancy **at that version**?" made a card kept at a newer version look new (see
    `utils.db.find_existing_ids`).
    """
    store = store or db_module.get_db()
    if not vacancies:
        return []
    ids_by_source: dict[str, list[str]] = {}
    for vacancy in vacancies:
        ids_by_source.setdefault(vacancy["source"], []).append(vacancy["external_id"])
    known = {
        source: store.find_existing_ids(source, ids) for source, ids in ids_by_source.items()
    }
    fresh = [
        vacancy for vacancy in vacancies if vacancy["external_id"] not in known[vacancy["source"]]
    ]
    log.info(
        "dedupe against the board",
        found=len(vacancies),
        already_known=len(vacancies) - len(fresh),
        new=len(fresh),
        sources=",".join(f"{source}:{len(ids)}" for source, ids in sorted(ids_by_source.items())),
    )
    return fresh


def create_cards(vacancies, user_id, cv_version, store=None) -> list[dict]:
    """Insert one card per vacancy; returns `{job_id, vacancy}` for the rows it really made.

    Each card is written with the site slug its own feed declared - the store's business key is
    `(user_id, source, external_id, cv_version)`, so a card that lost its slug here would collide
    with another site's vacancy that happens to share the number.

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
                "source": vacancy["source"],
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
