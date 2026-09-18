"""Real-Postgres integration tests for the production data plane.

These only run when TEST_DATABASE_URL points at a **throwaway** database (a CI
service container or a local docker-compose Postgres); they are skipped
otherwise, so the default suite stays hermetic.

They exist because the local JSON backend does not enforce column types, which
is exactly how an incompatible ``job_id`` (and a pooler-incompatible connection)
slipped through the first time.
"""

import os
import uuid

import pytest

pytestmark = pytest.mark.skipif(
    not os.getenv("TEST_DATABASE_URL"),
    reason="set TEST_DATABASE_URL to a throwaway Postgres to run the prod-store tests",
)


@pytest.fixture()
def store():
    from utils.db import PostgresDb

    db = PostgresDb(dsn=os.environ["TEST_DATABASE_URL"])
    # The database must be disposable: drop whatever a previous run left behind.
    with db.connection() as conn:
        with conn.cursor() as cur:
            cur.execute("drop table if exists resumes, model_availability, app_settings")
        conn.commit()
    db._schema_ready = False
    db.ensure_schema()
    yield db
    with db.connection() as conn:
        with conn.cursor() as cur:
            cur.execute("drop table if exists resumes, model_availability, app_settings")
        conn.commit()


def _row(job_id, external_id="848944", status="processing", user_id=None):
    return {
        "job_id": job_id,
        "user_id": user_id,
        "external_id": external_id,
        "title": "Platform Engineering Lead",
        "company": "UPPeople",
        "source_url": None,
        "cv_version": "v1",
        "status": status,
        "attempts": 0,
    }


def test_schema_is_created_and_accepts_a_non_uuid_job_id(store):
    """Regression guard: job_id is an opaque string, not a uuid column."""
    job_id = "848944-1789668742"
    result = store.upsert_job(_row(job_id))
    assert result["outcome"] == "claimed"
    assert store.get_job(job_id)["external_id"] == "848944"


def test_uuid_job_ids_also_work(store):
    job_id = str(uuid.uuid4())
    assert store.upsert_job(_row(job_id))["outcome"] == "claimed"
    assert store.get_job(job_id)["status"] == "processing"


def test_shape_guard_rejects_garbage(store):
    import psycopg

    with pytest.raises(psycopg.errors.CheckViolation):
        store.upsert_job(_row("has spaces and slashes/"))


def test_increment_update_and_find_completed_round_trip(store):
    job_id = "848944-1"
    store.upsert_job(_row(job_id))

    assert store.increment_attempts(job_id) == 1
    assert store.increment_attempts(job_id) == 2

    updated = store.update_job(job_id, status="completed", pdf_url="https://x/p.pdf")
    assert updated["status"] == "completed"
    assert store.find_completed("local:848944:v1")["job_id"] == job_id

    store.update_job(job_id, status="completed", error=None, revision_count=2)
    row = store.get_job(job_id)
    assert row["revision_count"] == 2


def test_duplicate_and_reclaim_paths(store):
    first = store.upsert_job(_row("848944-1"))
    assert first["outcome"] == "claimed"

    # Same vacancy, still processing -> duplicate delivery.
    assert store.upsert_job(_row("848944-2"))["outcome"] == "duplicate"

    # Failed attempt -> the retry re-claims the *same* row.
    store.update_job("848944-1", status="failed", error="boom")
    retry = store.upsert_job(_row("848944-3"))
    assert retry["outcome"] == "claimed"
    assert retry["job_id"] == "848944-1"
    assert store.get_job("848944-1")["error"] is None

    # Different vacancy reusing an existing job_id -> refuse.
    assert store.upsert_job(_row("848944-1", external_id="999999"))["outcome"] == "owned"


def test_model_state_ledger_round_trip(store):
    """The shared availability ledger is written with upserts, not a file."""
    from utils import model_state

    state = model_state.PostgresModelStateStore(db=store)
    state.save(
        {
            "current_model": "gemini-x",
            "unavailable": [{"name": "gemini-old", "reason": "429"}],
        }
    )
    loaded = state.load()
    assert loaded["current_model"] == "gemini-x"
    assert [item["name"] for item in loaded["unavailable"]] == ["gemini-old"]

    # Saving again replaces the ledger atomically (no duplicate rows).
    state.save({"current_model": "gemini-y", "unavailable": []})
    loaded = state.load()
    assert loaded["current_model"] == "gemini-y"
    assert loaded["unavailable"] == []
    assert "updated_at" in loaded
