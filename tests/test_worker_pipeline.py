"""End-to-end worker behaviour (no broker, no network, no LibreOffice)."""

import copy
import os
import tempfile
from unittest import mock

import config
import worker
from tests.helpers import SAMPLE_CV_DATA, fake_gemini, isolated_config, list_dir, sample_task
from utils import db as db_module
from utils.messaging import Delivery, Outcome, get_queue
from utils.retry import RetryLater

TAILORED_SUMMARY = "Platform Engineering Lead with Azure delivery record."


def _files(queue, bucket):
    return list_dir(os.path.join(queue.base_dir, bucket))


def test_worker_processes_one_message_end_to_end():
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            queue = get_queue("directory")
            queue.publish(sample_task())

            with fake_gemini([(SAMPLE_CV_DATA["summary"], TAILORED_SUMMARY)]):
                exit_code = worker.main(
                    ["--once", "--skip-preflight", "--queue-backend", "directory"]
                )

            assert exit_code == 0
            assert len(_files(queue, "processed")) == 1
            assert _files(queue, "retry") == []

            # persist node uploaded both artifacts through the storage backend
            assert os.path.exists(os.path.join(config.OUTPUT_DIR, "848944.pdf"))
            assert os.path.exists(os.path.join(config.OUTPUT_DIR, "848944.docx"))

            job = db_module.get_db().get_job("job-848944")
            assert job["status"] == "completed"
            assert job["is_approved"] is True
            assert job["pdf_url"].endswith("848944.pdf")
            assert job["revision_count"] == 1
            assert job["duration_ms"] is not None

            # per-job temp dirs are cleaned up
            assert not os.path.exists(os.path.join(config.TEMP_ROOT, "job-848944"))


def test_duplicate_message_is_acked_without_regenerating():
    """Two messages with the same idempotency key must pay for Gemini once.

    The directory backend picks messages up in arbitrary (uuid) order, so the
    assertion is order-independent: exactly one job row, one LLM run, two acks.
    """
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            queue = get_queue("directory")
            queue.publish(sample_task())
            # Same (user, external_id, cv_version) idempotency key, new job id.
            queue.publish(sample_task(job_id="job-848944-retry"))

            calls = {}
            with fake_gemini([(SAMPLE_CV_DATA["summary"], TAILORED_SUMMARY)], calls=calls):
                exit_code = worker.main(
                    ["--once", "--skip-preflight", "--queue-backend", "directory"]
                )

            assert exit_code == 0
            assert len(_files(queue, "processed")) == 2
            assert calls["adapt"] == 1, "the duplicate must be acked, not regenerated"

            rows = [
                row
                for row in (
                    db_module.get_db().get_job("job-848944"),
                    db_module.get_db().get_job("job-848944-retry"),
                )
                if row
            ]
            assert len(rows) == 1
            assert rows[0]["status"] == "completed"


def test_invalid_payload_is_dead_lettered():
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            delivery = Delivery(payload={"description_raw": "no external id"})
            result = worker.handle_delivery(delivery)
            assert result.outcome == Outcome.DEAD_LETTER


def test_master_cv_drift_fails_the_task_and_requests_a_retry():
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            drifted = copy.deepcopy(SAMPLE_CV_DATA)
            drifted["summary"] = "A summary that is not present in the master cv.docx."
            payload = sample_task(include_cv_data=True)
            payload["cv_data"] = drifted

            with fake_gemini([(drifted["summary"], TAILORED_SUMMARY)]):
                result = worker.handle_delivery(Delivery(payload=payload))

            assert result.outcome == Outcome.RETRY
            job = db_module.get_db().get_job("job-848944")
            assert job["status"] == "failed"
            assert "out of sync" in job["error"]


def test_quota_exhaustion_defers_the_task_instead_of_blocking():
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            payload = sample_task()
            with mock.patch.object(
                worker, "run_task", side_effect=RetryLater("daily quota exhausted", 1800)
            ):
                result = worker.handle_delivery(Delivery(payload=payload))

            assert result.outcome == Outcome.RETRY_LATER
            assert result.delay_seconds == 1800
            job = db_module.get_db().get_job("job-848944")
            assert job["status"] == "rate_limited"


def test_repeated_failures_park_the_message_in_the_dlq():
    max_attempts = config.MAX_ATTEMPTS
    try:
        config.MAX_ATTEMPTS = 2
        with tempfile.TemporaryDirectory() as tmp:
            with isolated_config(tmp):
                payload = sample_task()
                with mock.patch.object(worker, "run_task", side_effect=RuntimeError("boom")):
                    first = worker.handle_delivery(Delivery(payload=payload))
                    second = worker.handle_delivery(Delivery(payload=payload))

                assert first.outcome == Outcome.RETRY
                assert second.outcome == Outcome.DEAD_LETTER
                job = db_module.get_db().get_job("job-848944")
                assert job["status"] == "dead_lettered"
    finally:
        config.MAX_ATTEMPTS = max_attempts
