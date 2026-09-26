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
            cur.execute(
                "drop table if exists resume_history, resume_board, resumes, "
                "model_availability, app_settings"
            )
        conn.commit()
    db._schema_ready = False
    db.ensure_schema()
    yield db
    with db.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "drop table if exists resume_history, resume_board, resumes, "
                "model_availability, app_settings"
            )
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


def test_board_tables_reference_the_job_row(store):
    """Kanban state is board-owned, keyed by job_id, and cascades with the vacancy."""
    job_id = "848944-board"
    store.upsert_job(_row(job_id, status="processing"))

    with store.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "insert into resume_board (job_id, stage) values (%s, %s)",
                (job_id, "applied"),
            )
            cur.execute(
                "insert into resume_history "
                "(job_id, actor, action, kind, from_state, to_state) "
                "values (%s, %s, %s, %s, %s, %s)",
                (job_id, "Me", "Applied through the careers portal", "move", "created", "applied"),
            )
            cur.execute("select stage from resume_board where job_id = %s", (job_id,))
            assert cur.fetchone()["stage"] == "applied"
            cur.execute("select count(*) as n from resume_history where job_id = %s", (job_id,))
            assert cur.fetchone()["n"] == 1
        conn.commit()

    # A manual board move must never touch the worker's own claim state.
    assert store.get_job(job_id)["status"] == "processing"

    with store.connection() as conn:
        with conn.cursor() as cur:
            cur.execute("delete from resumes where job_id = %s", (job_id,))
            cur.execute("select count(*) as n from resume_board where job_id = %s", (job_id,))
            assert cur.fetchone()["n"] == 0
            cur.execute("select count(*) as n from resume_history where job_id = %s", (job_id,))
            assert cur.fetchone()["n"] == 0
        conn.commit()


def test_board_history_rejects_sloppy_rows(store):
    """The table enforces the dialog's contract, so a bad row can never land."""
    import psycopg

    job_id = "848944-history"
    store.upsert_job(_row(job_id))

    bad_rows = [
        ("Someone", "moved", "move"),  # actor is a two-option dropdown
        ("Me", "", "move"),  # the reason is required
        ("Me", "moved", "sideways"),  # kind is move | tailoring
    ]
    with store.connection() as conn:
        with conn.cursor() as cur:
            for actor, action, kind in bad_rows:
                with pytest.raises(psycopg.errors.CheckViolation):
                    cur.execute(
                        "insert into resume_history "
                        "(job_id, actor, action, kind, from_state, to_state) "
                        "values (%s, %s, %s, %s, 'created', 'applied')",
                        (job_id, actor, action, kind),
                    )
                conn.rollback()
        conn.commit()


def test_app_users_are_provisioned_not_signed_up(store):
    """Accounts exist only because an admin created them; the email is unique."""
    import psycopg

    row = ("u-1", "andrei@example.com", "Andrei", "scrypt$1$2$3$4", True)
    with store.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "insert into app_users (id, email, display_name, password_hash, is_admin) "
                "values (%s, %s, %s, %s, %s)",
                row,
            )
            cur.execute("select email, is_active, is_admin from app_users where id = %s", ("u-1",))
            created = cur.fetchone()
            assert created["email"] == "andrei@example.com"
            assert created["is_active"] is True  # usable straight away
            assert created["is_admin"] is True

            # A second account cannot take the same email (the UI has no signup path,
            # so this is the only way a duplicate could ever appear).
            with pytest.raises(psycopg.errors.UniqueViolation):
                cur.execute(
                    "insert into app_users (id, email, password_hash) values (%s, %s, %s)",
                    ("u-2", "andrei@example.com", "scrypt$5$6$7$8"),
                )
            conn.rollback()
        conn.commit()
