"""Claim semantics of the job store (option A: opaque client-supplied job_id).

These cover the duplicate/ownership paths that only differ from the happy path
once two messages describe the same vacancy or reuse a row id.
"""

import tempfile

import worker
from agent.contracts import JobStatus
from tests.helpers import isolated_config, sample_task
from utils import db as db_module
from utils.messaging import Delivery, Outcome


def _row(task, status=JobStatus.PROCESSING):
    return {
        "job_id": task["job_id"],
        "user_id": task.get("user_id"),
        "external_id": task["external_id"],
        "title": task.get("title"),
        "company": task.get("company"),
        "source_url": task.get("source_url"),
        "cv_version": task.get("cv_version", "v1"),
        "status": status,
        "attempts": task.get("attempt", 0),
    }


def test_fresh_vacancy_is_claimed():
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            task = sample_task()
            result = db_module.get_db().upsert_job(_row(task))
            assert result["outcome"] == "claimed"
            assert result["job_id"] == "job-848944"


def test_second_message_for_an_in_flight_vacancy_is_a_duplicate():
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            store = db_module.get_db()
            first = store.upsert_job(_row(sample_task()))
            assert first["outcome"] == "claimed"

            # Same vacancy + cv_version, different job_id, first still processing.
            second = store.upsert_job(_row(sample_task(job_id="job-848944-again")))
            assert second["outcome"] == "duplicate"
            assert second["job_id"] == first["job_id"]


def test_failed_row_is_reclaimed_under_its_original_row_id():
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            store = db_module.get_db()
            first = store.upsert_job(_row(sample_task()))
            store.update_job(first["job_id"], status=JobStatus.FAILED, error="boom")

            # The retry carries a *new* job_id but must reuse the existing row:
            # the vacancy key is unique, so inserting again would collide.
            retry = store.upsert_job(_row(sample_task(job_id="job-848944-retry")))
            assert retry["outcome"] == "claimed"
            assert retry["job_id"] == first["job_id"], "the row id must be reused"
            assert retry["row"]["error"] is None, "the previous error is cleared"

            assert len(store.list_jobs()) == 1, "no duplicate rows for one vacancy"


def test_job_id_owned_by_another_vacancy_is_refused():
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            store = db_module.get_db()
            first = store.upsert_job(_row(sample_task()))
            assert first["outcome"] == "claimed"

            # Same job_id (row id) but a *different* vacancy: a buggy publisher
            # reusing an id must not be allowed to rewrite the foreign row.
            clash = store.upsert_job(
                _row(sample_task(external_id="999999", job_id="job-848944"))
            )
            assert clash["outcome"] == "owned"
            assert store.get_job("job-848944")["external_id"] == "848944"


def test_completed_vacancy_is_reported_completed_not_duplicate():
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            store = db_module.get_db()
            first = store.upsert_job(_row(sample_task()))
            store.update_job(first["job_id"], status=JobStatus.COMPLETED, pdf_url="u/p.pdf")

            # find_completed() is the primary duplicate guard in the worker...
            assert store.find_completed("local:848944:v1") is not None
            # ...and the claim path also refuses to adopt the row.
            again = store.upsert_job(_row(sample_task(job_id="job-848944-again")))
            assert again["outcome"] == "duplicate"


def test_worker_acks_an_in_flight_duplicate_without_any_llm_call():
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            store = db_module.get_db()
            store.upsert_job(_row(sample_task()))  # claimed by "another pod"

            result = worker.handle_delivery(Delivery(payload=sample_task(job_id="job-848944-2")))
            assert result.outcome == Outcome.ACK
            assert result.reason == "duplicate"
