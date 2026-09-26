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
                "board_actions, model_availability, app_settings"
            )
        conn.commit()
    db._schema_ready = False
    db.ensure_schema()
    yield db
    with db.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "drop table if exists resume_history, resume_board, resumes, "
                "board_actions, model_availability, app_settings"
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


def test_gateway_created_row_is_adopted_by_the_claim(store):
    """The ingest gateway creates a vacancy's row *before* publishing, so the card is
    on the board the moment a page is scraped. The worker's claim must therefore
    *adopt* that row: a "duplicate" verdict would ack the message and leave the card in
    Created forever.
    """
    from agent.contracts import JobStatus
    from utils.db import ACTIVE_STATUSES

    # The invariant the whole ingest path rests on (see backoffice/src/lib/ingest.ts).
    assert JobStatus.SUBMITTED not in ACTIVE_STATUSES

    job_id = str(uuid.uuid4())
    with store.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "insert into resumes "
                "(job_id, user_id, external_id, title, company, cv_version, status) "
                "values (%s, 'u-1', '900001', 'Scraped role', 'ACME', 'v1', %s)",
                (job_id, JobStatus.SUBMITTED),
            )
        conn.commit()

    claim = store.upsert_job(
        _row(job_id, external_id="900001", status=JobStatus.PROCESSING, user_id="u-1")
    )
    assert claim["outcome"] == "claimed"
    assert claim["job_id"] == job_id  # the board card and the worker's row are one row

    row = store.get_job(job_id)
    assert row["status"] == JobStatus.PROCESSING
    assert row["title"] == "Scraped role"  # what the scraper saw survives the claim


def test_a_queued_row_would_be_acknowledged_as_a_duplicate_instead(store):
    """Why the gateway must not pre-create rows as `queued`: that status is *active*, so
    the claim would ack the message as a duplicate delivery without doing any work.
    """
    from agent.contracts import JobStatus

    job_id = str(uuid.uuid4())
    with store.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "insert into resumes "
                "(job_id, user_id, external_id, cv_version, status) "
                "values (%s, 'u-1', '900002', 'v1', %s)",
                (job_id, JobStatus.QUEUED),
            )
        conn.commit()

    claim = store.upsert_job(
        _row(job_id, external_id="900002", status=JobStatus.PROCESSING, user_id="u-1")
    )
    assert claim["outcome"] == "duplicate"
    assert store.get_job(job_id)["status"] == JobStatus.QUEUED



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
                (job_id, "Candidate", "Applied through the careers portal", "move", "created", "applied"),
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
        ("Candidate", "", "move"),  # the reason is required
        ("Candidate", "moved", "sideways"),  # kind is move | tailoring | archive | restore
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


def test_archive_is_an_in_place_soft_delete(store):
    """Archiving writes the board's own columns plus one audit row. The stage the
    vacancy reached - and the worker's status - are never touched: that is what keeps
    the funnel readable (in the board's model "archived" is a state, not a column).
    """
    job_id = "848944-archive"
    store.upsert_job(_row(job_id, status="completed"))

    with store.connection() as conn:
        with conn.cursor() as cur:
            cur.execute("insert into resume_board (job_id, stage) values (%s, 'interviewing')", (job_id,))
            # One transaction, exactly like the API route: columns + history row.
            cur.execute(
                "update resume_board set archived_at = now(), archived_actor = %s, "
                "archived_reason = %s, updated_at = now() where job_id = %s",
                ("Company", "Salary mismatch", job_id),
            )
            cur.execute(
                "insert into resume_history (job_id, actor, action, kind, from_state, to_state) "
                "values (%s, %s, %s, 'archive', 'active', 'archived')",
                (job_id, "Company", "Salary mismatch"),
            )
            cur.execute(
                "select stage, archived_actor, archived_reason, archived_at is not null as archived "
                "from resume_board where job_id = %s",
                (job_id,),
            )
            archived = cur.fetchone()
        conn.commit()

    assert archived["stage"] == "interviewing"  # in place: the column never moves
    assert archived["archived"] is True
    assert archived["archived_actor"] == "Company"
    assert archived["archived_reason"] == "Salary mismatch"
    assert store.get_job(job_id)["status"] == "completed"  # the worker's claim state is untouched

    # Restore clears the three columns and is audited as well.
    with store.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "update resume_board set archived_at = null, archived_actor = null, "
                "archived_reason = null, updated_at = now() where job_id = %s",
                (job_id,),
            )
            cur.execute(
                "insert into resume_history (job_id, actor, action, kind, from_state, to_state) "
                "values (%s, 'Candidate', 'Restored to the active pipeline', 'restore', "
                "'archived', 'active')",
                (job_id,),
            )
            cur.execute(
                "select stage, archived_at, archived_actor, archived_reason "
                "from resume_board where job_id = %s",
                (job_id,),
            )
            restored = cur.fetchone()
            cur.execute(
                "select kind, from_state, to_state from resume_history where job_id = %s order by id",
                (job_id,),
            )
            history = cur.fetchall()
        conn.commit()

    assert restored["archived_at"] is None
    assert restored["archived_actor"] is None
    assert restored["archived_reason"] is None
    assert restored["stage"] == "interviewing"
    assert [(row["kind"], row["from_state"], row["to_state"]) for row in history] == [
        ("archive", "active", "archived"),
        ("restore", "archived", "active"),
    ]


def test_archiving_requires_an_actor_and_a_reason(store):
    """The all-or-nothing guard behind the Archive dialog: a row cannot claim to be
    refused without both, and only the dropdown's vocabulary is accepted."""
    import psycopg

    job_id = "848944-partial"
    store.upsert_job(_row(job_id))
    with store.connection() as conn:
        with conn.cursor() as cur:
            cur.execute("insert into resume_board (job_id, stage) values (%s, 'applied')", (job_id,))
        conn.commit()

    rejected = [
        # no actor and no reason at all
        "update resume_board set archived_at = now() where job_id = %s",
        # an actor without a reason
        "update resume_board set archived_at = now(), archived_actor = 'Candidate' where job_id = %s",
        # the pre-2026-09-26 vocabulary is gone (migrated in place)
        "update resume_board set archived_at = now(), archived_actor = 'Me', "
        "archived_reason = 'x' where job_id = %s",
        # an empty reason is not a reason
        "update resume_board set archived_at = now(), archived_actor = 'Candidate', "
        "archived_reason = '' where job_id = %s",
    ]

    with store.connection() as conn:
        with conn.cursor() as cur:
            for statement in rejected:
                with pytest.raises(psycopg.errors.CheckViolation):
                    cur.execute(statement, (job_id,))
                conn.rollback()
        conn.commit()


def test_history_vocabulary_is_candidate_and_company(store):
    """The stored actor vocabulary is the dialog's dropdown, and the history knows the
    two soft-delete transitions."""
    import psycopg

    job_id = "848944-vocab"
    store.upsert_job(_row(job_id))

    accepted = [
        ("Candidate", "move"),
        ("Company", "tailoring"),
        ("Candidate", "archive"),
        ("Company", "restore"),
    ]
    with store.connection() as conn:
        with conn.cursor() as cur:
            for actor, kind in accepted:
                cur.execute(
                    "insert into resume_history (job_id, actor, action, kind, from_state, to_state) "
                    "values (%s, %s, 'x', %s, 'a', 'b')",
                    (job_id, actor, kind),
                )
        conn.commit()

    rejected = [("Me", "move"), ("Them", "move"), ("Candidate", "sideways")]
    with store.connection() as conn:
        with conn.cursor() as cur:
            for actor, kind in rejected:
                with pytest.raises(psycopg.errors.CheckViolation):
                    cur.execute(
                        "insert into resume_history (job_id, actor, action, kind, from_state, to_state) "
                        "values (%s, %s, 'x', %s, 'a', 'b')",
                        (job_id, actor, kind),
                    )
                conn.rollback()
            cur.execute("select count(*) as n from resume_history where job_id = %s", (job_id,))
            assert cur.fetchone()["n"] == len(accepted)
        conn.commit()


def test_board_actions_is_a_persisted_vocabulary(store):
    """Actions are rows, not a code enum: the seed ships with the schema and a typed
    value is persisted (and counted) by the same upsert the dialogs use."""
    with store.connection() as conn:
        with conn.cursor() as cur:
            cur.execute("select count(*) as n from board_actions where kind = 'archive'")
            assert cur.fetchone()["n"] >= 7
            cur.execute("select count(*) as n from board_actions where kind = 'move'")
            assert cur.fetchone()["n"] >= 4

            # One row per action; the first use counts as 1, later uses add up. (The
            # insert carries `uses = 1` on purpose: the column default 0 would make a
            # brand-new value look unused.)
            upsert = (
                "insert into board_actions (action, kind, uses) values (%s, %s, 1) "
                "on conflict (action) do update set uses = board_actions.uses + 1, "
                "last_used_at = now() returning uses, kind"
            )
            cur.execute(upsert, ("Salary mismatch", "archive"))
            assert cur.fetchone()["uses"] == 1
            cur.execute(upsert, ("Salary mismatch", "archive"))
            assert cur.fetchone()["uses"] == 2

            # Whatever the operator typed is what the next suggestion list offers.
            cur.execute(upsert, ("Asked for a portfolio", "move"))
            fresh = cur.fetchone()
            assert fresh["uses"] == 1
            assert fresh["kind"] == "move"
        conn.commit()


def test_the_action_catalogue_can_be_administered(store):
    """The three writes behind `/admin`, with the SQL the routes send.

    Mirrors `backoffice/src/lib/db.ts::{insertAction,renameAction,deleteAction}` - if that
    SQL changes, this is the test that says whether the database still agrees (return
    values included: `on conflict do nothing returning` is what tells add from "exists").
    """
    job_id = "848944-admin"
    store.upsert_job(_row(job_id))

    with store.connection() as conn:
        with conn.cursor() as cur:
            # Seed a used catalogue entry, exactly as a confirmed change would leave it.
            cur.execute("update board_actions set uses = 4 where action = 'No response'")

            # rename: insert the new wording carrying `uses`, then drop the old key
            cur.execute(
                "insert into board_actions (action, kind, uses, created_at, last_used_at) "
                "select 'No reply', kind, uses, now(), now() from board_actions where action = 'No response'"
            )
            cur.execute("delete from board_actions where action = 'No response'")
            cur.execute("select kind, uses from board_actions where action = 'No reply'")
            renamed = cur.fetchone()
            assert renamed["kind"] == "archive"
            assert renamed["uses"] == 4  # the counter follows the wording

            # add: the insert returns a row only when it actually created one
            cur.execute(
                "insert into board_actions (action, kind) values ('Asked for a portfolio', 'move') "
                "on conflict (action) do nothing returning action"
            )
            assert cur.rowcount == 1
            cur.execute(
                "insert into board_actions (action, kind) values ('Asked for a portfolio', 'move') "
                "on conflict (action) do nothing returning action"
            )
            assert cur.rowcount == 0  # -> the route answers 409

            # remove: catalogue only
            cur.execute("delete from board_actions where action = 'Salary mismatch'")
            assert cur.rowcount == 1
            cur.execute("select count(*) as n from board_actions where action = 'Salary mismatch'")
            assert cur.fetchone()["n"] == 0
            # ... and removing it twice is a 404, not a silent success
            cur.execute("delete from board_actions where action = 'Salary mismatch'")
            assert cur.rowcount == 0
        conn.commit()


def test_a_removed_action_is_still_visible_to_history(store):
    """Vocabulary values are the union of the catalogue and what history recorded.

    Mirrors the query in `backoffice/src/lib/db.ts::fetchActionVocabulary`: a value removed
    from `board_actions` must come back as `catalogued = false` (filterable, no longer
    suggested) while the history rows keep the words they were recorded with.
    """
    job_id = "848944-retired"
    store.upsert_job(_row(job_id))

    with store.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "insert into resume_history (job_id, actor, action, kind, from_state, to_state) "
                "values (%s, 'Company', 'Salary mismatch', 'archive', 'active', 'archived')",
                (job_id,),
            )
            cur.execute("delete from board_actions where action = 'Salary mismatch'")
            cur.execute(
                """
                select value, kind, uses, catalogued
                  from (
                    select a.action as value, a.kind, a.uses, true as catalogued
                      from board_actions a
                    union all
                    select h.action as value,
                           (case when bool_or(h.kind = 'archive') then 'archive' else 'move' end),
                           count(*)::int,
                           false
                      from resume_history h
                     where not exists (select 1 from board_actions a where a.action = h.action)
                     group by h.action
                  ) vocabulary
                 where value = 'Salary mismatch'
                """
            )
            retired = cur.fetchone()

            # The audit trail is untouched by the catalogue delete...
            cur.execute("select action from resume_history where job_id = %s", (job_id,))
            assert cur.fetchone()["action"] == "Salary mismatch"
        conn.commit()

    assert retired["catalogued"] is False
    assert retired["kind"] == "archive"  # derived from the history kind
    assert retired["uses"] == 1


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
