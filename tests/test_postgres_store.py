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
from datetime import timedelta

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
                "drop table if exists resume_interview, process_runs, resume_application, "
                "resume_cover_letter, resume_docx_update, resume_history, resume_board, resumes, "
                "application_profile, app_users, board_actions, artifact_purge, "
                "model_availability, app_settings"
            )
        conn.commit()
    db._schema_ready = False
    db.ensure_schema()
    yield db
    with db.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "drop table if exists resume_interview, process_runs, resume_application, "
                "resume_cover_letter, resume_docx_update, resume_history, resume_board, resumes, "
                "application_profile, app_users, board_actions, artifact_purge, "
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
    assert store.find_completed("local:djinni:848944:v1")["job_id"] == job_id

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
                (job_id, "Candidate", "Applied through the careers portal", "move", "prepare", "applied"),
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


def test_a_removed_action_leaves_the_vocabulary_and_stays_in_history(store):
    """The Action vocabulary is the catalogue - `board_actions`, nothing else.

    Mirrors `backoffice/src/lib/db.ts::fetchActionVocabulary`: the read lists the catalogue
    only, so removing an entry takes it out of every list (no dialog suggests it, no filter
    offers it) while `resume_history` keeps the wording it was recorded with - which is what
    the card's own History section still shows (invariant 19).
    """
    job_id = "848944-removed"
    store.upsert_job(_row(job_id))

    with store.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "insert into resume_history (job_id, actor, action, kind, from_state, to_state) "
                "values (%s, 'Company', 'Salary mismatch', 'archive', 'active', 'archived')",
                (job_id,),
            )

            cur.execute("delete from board_actions where action = 'Salary mismatch'")
            assert cur.rowcount == 1

            # The vocabulary read - a plain `board_actions` select - has no such value...
            cur.execute(
                "select count(*) as n from board_actions where action = 'Salary mismatch'"
            )
            assert cur.fetchone()["n"] == 0

            # ...and the audit trail is untouched by the catalogue delete.
            cur.execute("select action from resume_history where job_id = %s", (job_id,))
            assert cur.fetchone()["action"] == "Salary mismatch"
        conn.commit()


def test_removing_a_card_cascades_and_queues_its_artifacts(store):
    """The SQL behind `POST /api/board/remove`.

    Mirrors `backoffice/src/lib/db.ts::{queueArtifactPurge,purgeCard}`: the queue is written
    first (the row's artifact paths are the only record of them), then the row goes - and the
    card, its column and its whole history go with it, because `resume_board` and
    `resume_history` cascade from `resumes`. Nothing is tombstoned: that is what "remove"
    means (invariant 22), and the queue deliberately has no foreign key to the deleted row.
    """
    job_id = "848944-remove"
    store.upsert_job(_row(job_id, status="completed"))

    with store.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "insert into resume_board "
                "(job_id, stage, archived_at, archived_actor, archived_reason) "
                "values (%s, 'interviewing', now(), 'Company', 'Salary mismatch')",
                (job_id,),
            )
            cur.execute(
                "insert into resume_history (job_id, actor, action, kind, from_state, to_state) "
                "values (%s, 'Company', 'Salary mismatch', 'archive', 'active', 'archived')",
                (job_id,),
            )

            # The paths the board could not delete: queued before the row disappears.
            paths = ["/data/output/848944.pdf", "/data/output/848944.docx"]
            cur.execute(
                "insert into artifact_purge (stored_path, job_id) "
                "select * from unnest(%s::text[], %s::text[]) "
                "on conflict (stored_path) do update set job_id = excluded.job_id, "
                "queued_at = now()",
                (paths, [job_id, job_id]),
            )
            cur.execute("select count(*) as n from artifact_purge where job_id = %s", (job_id,))
            assert cur.fetchone()["n"] == 2

            cur.execute("delete from resumes where job_id = %s", (job_id,))
            assert cur.rowcount == 1
        conn.commit()

    with store.connection() as conn:
        with conn.cursor() as cur:
            for table in ("resumes", "resume_board", "resume_history"):
                cur.execute(f"select count(*) as n from {table} where job_id = %s", (job_id,))
                assert cur.fetchone()["n"] == 0, table
            # The queue outlives the card: it is what `storage-files.ps1 -Action purge` reads.
            cur.execute("select count(*) as n from artifact_purge where job_id = %s", (job_id,))
            assert cur.fetchone()["n"] == 2
            cur.execute("delete from artifact_purge where job_id = %s", (job_id,))
            assert cur.rowcount == 2
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


def test_a_legacy_database_is_migrated_to_the_source_and_scraped_vocabulary(store):
    """A database created before the source/Scraped rework must come out the other side.

    The old shape is built by hand - no `source`/`description_raw`, the three-column unique
    index, `stage = 'created'` on the board and `created` in the history vocabulary - and then
    `ensure_schema()` has to bring it forward without losing the rows.
    """
    from utils.db import PostgresDb

    with store.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "drop table if exists resume_interview, process_runs, resume_application, "
                "resume_cover_letter, resume_docx_update, resume_history, resume_board, resumes, "
                "application_profile, app_users, board_actions, artifact_purge, "
                "model_availability, app_settings"
            )
            cur.execute(
                """
                create table resumes (
                    job_id      text primary key,
                    user_id     text,
                    external_id text not null,
                    title       text,
                    company     text,
                    source_url  text,
                    cv_version  text not null default 'v1',
                    status      text not null default 'queued',
                    attempts    integer not null default 0,
                    created_at  timestamptz not null default now(),
                    updated_at  timestamptz not null default now()
                )
                """
            )
            cur.execute(
                "create unique index resumes_job_key_idx"
                " on resumes (coalesce(user_id, 'local'), external_id, cv_version)"
            )
            cur.execute(
                "create table resume_board ("
                " job_id text primary key, stage text not null default 'created',"
                " updated_at timestamptz not null default now())"
            )
            cur.execute(
                "create table resume_history ("
                " id bigserial primary key, job_id text not null,"
                " at timestamptz not null default now(), actor text not null,"
                " action text not null, kind text not null,"
                " from_state text not null, to_state text not null)"
            )
            cur.execute(
                "insert into resumes (job_id, user_id, external_id, status)"
                " values ('legacy-1', 'u-1', '848944', 'completed')"
            )
            cur.execute("insert into resume_board (job_id, stage) values ('legacy-1', 'created')")
            cur.execute(
                "insert into resume_history (job_id, actor, action, kind, from_state, to_state)"
                " values ('legacy-1', 'Candidate', 'Applied online', 'move', 'created', 'applied')"
            )
        conn.commit()

    migrated = PostgresDb(dsn=os.environ["TEST_DATABASE_URL"])
    migrated.ensure_schema()

    with migrated.connection() as conn:
        with conn.cursor() as cur:
            cur.execute("select source, description_raw from resumes where job_id = 'legacy-1'")
            row = cur.fetchone()
            assert row["source"] == "djinni", "the new column back-fills old rows"
            assert row["description_raw"] is None, "there is no job description to invent"

            cur.execute("select stage from resume_board where job_id = 'legacy-1'")
            assert cur.fetchone()["stage"] == "prepare", "Created became Prepare"

            cur.execute("select from_state from resume_history where job_id = 'legacy-1'")
            assert cur.fetchone()["from_state"] == "prepare", "the history vocabulary moved too"

            cur.execute("select indexdef from pg_indexes where indexname = 'resumes_job_key_idx'")
            assert "source" in cur.fetchone()["indexdef"], "the business key was rebuilt"

            # The rebuilt key separates sites - the whole point of the column - and one
            # site's own number is still unique (the next block proves it).
            cur.execute(
                "insert into resumes (job_id, user_id, external_id, source, status)"
                " values ('dou-1', 'u-1', '848944', 'dou', 'queued')"
            )
        conn.commit()

    import psycopg

    with migrated.connection() as conn:
        with conn.cursor() as cur:
            with pytest.raises(psycopg.errors.UniqueViolation):
                cur.execute(
                    "insert into resumes (job_id, user_id, external_id, source, status)"
                    " values ('dup-1', 'u-1', '848944', 'djinni', 'queued')"
                )



def test_cover_letters_are_one_row_per_vacancy(store):
    """The cover worker's table: one row per vacancy, refreshed in place, gone with the card.

    `text`/`model` survive a later failed attempt (a retry must not wipe a letter that is
    already there) and `attempts` only grows - both are what the worker relies on.
    """
    job_id = "cover-row-1"
    store.upsert_job(_row(job_id))

    first = store.upsert_cover_letter(job_id, "queued", attempts=1)
    assert first["status"] == "queued"
    assert first["text"] is None

    store.upsert_cover_letter(
        job_id, "completed", text="Hello,\n\nletter", model="gemini-x", attempts=2
    )
    failed = store.upsert_cover_letter(job_id, "failed", error="boom", attempts=3)
    assert failed["status"] == "failed"
    assert failed["text"] == "Hello,\n\nletter"
    assert failed["model"] == "gemini-x"
    assert failed["attempts"] == 3

    assert store.get_cover_letter(job_id)["text"] == "Hello,\n\nletter"

    # Removal takes the letter with it (the row cascades from `resumes`).
    with store.connection() as conn:
        with conn.cursor() as cur:
            cur.execute("delete from resumes where job_id = %s", (job_id,))
        conn.commit()
    assert store.get_cover_letter(job_id) is None


# -- the automation's tables: interviews, the run ledger, the inactivity sweep --------- #


def _seed_card(store, job_id, stage="applied", quiet_days=30, status="completed"):
    """A card plus the board row the sweep reads, quiet for `quiet_days`.

    The board's `updated_at` is written explicitly: it is the *activity* clock the sweep
    dates a card by, and `resumes.updated_at` (which `upsert_job` sets to now) must not be
    able to hide a card that has been sitting untouched for a month.
    """
    store.upsert_job(_row(job_id, external_id=job_id, status=status))
    with store.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                insert into resume_board (job_id, stage, updated_at)
                values (%s, %s, now() - %s)
                on conflict (job_id) do update
                    set stage = excluded.stage, updated_at = excluded.updated_at
                """,
                (job_id, stage, timedelta(days=quiet_days)),
            )
        conn.commit()
    return job_id


def test_the_interview_types_are_the_four_the_section_offers(store):
    """The section's four types are code + this CHECK (exactly like the Actors); the result
    is free text with a cap, because it is what the operator wrote after the call."""
    import psycopg

    job_id = _seed_card(store, "interview-types-1")

    accepted = [
        "Initial Interview",
        "Technical Interview",
        "Management Interview",
        "Final Interview",
    ]
    with store.connection() as conn:
        with conn.cursor() as cur:
            for interview_type in accepted:
                cur.execute(
                    "insert into resume_interview (job_id, scheduled_at, type, result)"
                    " values (%s, now() + interval '1 day', %s, 'went well')",
                    (job_id, interview_type),
                )
            cur.execute("select count(*) as n from resume_interview where job_id = %s", (job_id,))
            assert cur.fetchone()["n"] == len(accepted)
        conn.commit()

    rejected = [
        ("Screening", None),  # not one of the four types
        ("Final Interview", "x" * 2001),  # the result cap
    ]
    with store.connection() as conn:
        with conn.cursor() as cur:
            for interview_type, result in rejected:
                with pytest.raises(psycopg.errors.CheckViolation):
                    cur.execute(
                        "insert into resume_interview (job_id, scheduled_at, type, result)"
                        " values (%s, now(), %s, %s)",
                        (job_id, interview_type, result),
                    )
                conn.rollback()
            # A scheduled interview without a date is not a scheduled interview.
            with pytest.raises(psycopg.errors.NotNullViolation):
                cur.execute(
                    "insert into resume_interview (job_id, type) values (%s, 'Initial Interview')",
                    (job_id,),
                )
            conn.rollback()
        conn.commit()

    # Removing the card for good takes its interviews with it (the row cascades).
    with store.connection() as conn:
        with conn.cursor() as cur:
            cur.execute("delete from resumes where job_id = %s", (job_id,))
            cur.execute("select count(*) as n from resume_interview where job_id = %s", (job_id,))
            assert cur.fetchone()["n"] == 0
        conn.commit()


def test_an_interview_never_writes_a_history_row(store):
    """The Interviews section *is* the interview history (`CONSTITUTION.md` invariant 26).

    Adding, editing and removing an interview must leave `resume_history` alone; only the
    *move* into Interviewing is an audited change, and that is what makes the section appear.
    """
    job_id = _seed_card(store, "interview-history-1", stage="interviewing")

    with store.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "insert into resume_interview (job_id, scheduled_at, type)"
                " values (%s, now(), 'Initial Interview') returning id",
                (job_id,),
            )
            interview_id = cur.fetchone()["id"]
            cur.execute(
                "update resume_interview set type = 'Technical Interview', result = %s,"
                " updated_at = now() where id = %s",
                ("Next round scheduled", interview_id),
            )
            cur.execute("delete from resume_interview where id = %s", (interview_id,))
            cur.execute("select count(*) as n from resume_history where job_id = %s", (job_id,))
            assert cur.fetchone()["n"] == 0
        conn.commit()


def test_the_cards_own_detail_fields_are_bounded_and_vocabulary_checked(store):
    """`recruiter` / `salary_offered` / `salary_desired` / `communication_channels` /
    `apply_url`: free text with a length cap, a channel list that may only hold the six values
    the card offers, and an application URL that must be http(s)."""
    import psycopg

    job_id = _seed_card(store, "details-1")

    with store.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "update resume_board set recruiter = %s, salary_offered = %s,"
                " salary_desired = %s, communication_channels = %s, apply_url = %s"
                " where job_id = %s",
                (
                    "Mariia Melenchuk",
                    "$5,000",
                    "6000 EUR",
                    ["Email", "Dou", "Djinni"],
                    "https://job-boards.eu.greenhouse.io/growe/jobs/4987494101",
                    job_id,
                ),
            )
            cur.execute(
                "select recruiter, salary_offered, salary_desired, communication_channels,"
                " apply_url from resume_board where job_id = %s",
                (job_id,),
            )
            row = cur.fetchone()
            assert row["recruiter"] == "Mariia Melenchuk"
            assert row["communication_channels"] == ["Email", "Dou", "Djinni"]
            assert row["apply_url"] == "https://job-boards.eu.greenhouse.io/growe/jobs/4987494101"
            # Every field is optional: NULL clears it, and an empty list is a real value.
            cur.execute(
                "update resume_board set recruiter = null, salary_offered = null,"
                " salary_desired = null, communication_channels = '{}', apply_url = null"
                " where job_id = %s",
                (job_id,),
            )
            cur.execute(
                "select recruiter, communication_channels, apply_url from resume_board"
                " where job_id = %s",
                (job_id,),
            )
            cleared = cur.fetchone()
            assert cleared["recruiter"] is None
            assert cleared["communication_channels"] == []
            assert cleared["apply_url"] is None
        conn.commit()

    rejected = [
        # an unknown channel
        ("update resume_board set communication_channels = array['Carrier pigeon']"
         " where job_id = %s", (job_id,)),
        # a NULL inside the array: `arr <@ known` is NULL for that, so the guard wraps it
        ("update resume_board set communication_channels = array['Email', null]"
         " where job_id = %s", (job_id,)),
        # an empty string is not a value (the UI sends NULL)
        ("update resume_board set recruiter = '' where job_id = %s", (job_id,)),
        # the 200-character cap, on every text field
        ("update resume_board set recruiter = repeat('x', 201) where job_id = %s", (job_id,)),
        ("update resume_board set salary_offered = repeat('x', 201) where job_id = %s", (job_id,)),
        ("update resume_board set salary_desired = repeat('x', 201) where job_id = %s", (job_id,)),
        # The application URL is the one detail with a *shape*: it is a link the board opens and
        # the extension matches a page against, so only http(s) can be stored.
        ("update resume_board set apply_url = 'javascript:alert(1)' where job_id = %s", (job_id,)),
        ("update resume_board set apply_url = 'djinni.co/jobs/848944' where job_id = %s", (job_id,)),
        ("update resume_board set apply_url = 'https://example.com/a b' where job_id = %s",
         (job_id,)),
        ("update resume_board set apply_url = 'https://' || repeat('x', 1000) where job_id = %s",
         (job_id,)),
    ]
    with store.connection() as conn:
        with conn.cursor() as cur:
            for statement, params in rejected:
                with pytest.raises(psycopg.errors.CheckViolation):
                    cur.execute(statement, params)
                conn.rollback()
        conn.commit()


def test_the_details_constraint_is_widened_for_the_application_url(store):
    """A database created before 2026-09-29 carries the four-field version of
    `resume_board_details_shape`, and the guard creates the check only `if not exists` - so
    `apply_url` would stay unguarded forever unless `ensure_schema()` rebuilds it.
    """
    import psycopg

    from utils.db import PostgresDb

    job_id = _seed_card(store, "details-url-1")

    # The old shape, on a table that already has the column (an earlier boot added it): exactly
    # the state a live cluster was in when the field shipped.
    with store.connection() as conn:
        with conn.cursor() as cur:
            cur.execute("alter table resume_board drop constraint resume_board_details_shape")
            cur.execute(
                "alter table resume_board add constraint resume_board_details_shape"
                " check (recruiter is null or char_length(recruiter) between 1 and 200)"
            )
        conn.commit()

    widened = PostgresDb(dsn=os.environ["TEST_DATABASE_URL"])
    widened.ensure_schema()

    with widened.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select pg_get_constraintdef(oid) as definition from pg_constraint"
                " where conname = 'resume_board_details_shape'"
            )
            definition = cur.fetchone()["definition"]
            assert "apply_url" in definition, "the rebuilt CHECK guards the new column"
            assert "communication_channels" in definition, "and keeps what it guarded before"
            cur.execute(
                "update resume_board set apply_url = %s where job_id = %s",
                ("https://job-boards.eu.greenhouse.io/growe/jobs/4987494101", job_id),
            )
        conn.commit()

    with widened.connection() as conn:
        with conn.cursor() as cur:
            with pytest.raises(psycopg.errors.CheckViolation):
                cur.execute(
                    "update resume_board set apply_url = 'not-a-url' where job_id = %s", (job_id,)
                )


def test_the_process_ledger_round_trips_with_its_counters(store):
    """What the board's Processes window reads: the run, its trigger, its outcome and the
    counters each job reports."""
    import psycopg

    first = store.start_process_run("feed-parser")
    store.finish_process_run(first, status="ok", summary={"new_cards": 3, "notified": 3})
    second = store.start_process_run("auto-archiver", trigger="manual")
    store.finish_process_run(second, status="failed", summary={"refused": 1}, error="boom")
    # The startup trigger: the intake's deploy-time hook run (`charts/cv-tailoring-scout`),
    # recorded with the same vocabulary a CronJob slot uses.
    third = store.start_process_run("feed-parser", trigger="startup")
    store.finish_process_run(third, status="ok", summary={"new_cards": 0})

    assert [run["id"] for run in store.list_process_runs()] == [third, second, first], "newest first"

    runs = {run["id"]: run for run in store.list_process_runs()}
    assert runs[first]["process"] == "feed-parser"
    assert runs[first]["trigger"] == "schedule"
    assert runs[first]["status"] == "ok"
    assert runs[first]["summary"] == {"new_cards": 3, "notified": 3}
    assert runs[first]["finished_at"] is not None
    assert runs[first]["error"] is None
    assert runs[second]["trigger"] == "manual"
    assert runs[second]["summary"] == {"refused": 1}
    assert runs[second]["error"] == "boom"
    assert runs[third]["trigger"] == "startup"
    assert runs[third]["status"] == "ok"

    # The slug shape and the five statuses are the window's vocabulary, not free text.
    rejected = [
        "insert into process_runs (process) values ('Feed Parser')",
        "insert into process_runs (process, status) values ('feed-parser', 'lost')",
        "insert into process_runs (process, trigger) values ('feed-parser', 'cron')",
    ]
    with store.connection() as conn:
        with conn.cursor() as cur:
            for statement in rejected:
                with pytest.raises(psycopg.errors.CheckViolation):
                    cur.execute(statement)
                conn.rollback()
        conn.commit()


def test_a_killed_run_is_retired_by_the_next_one(store):
    """A row left `running` by a dead pod would look in-flight forever - and only an old
    one may be touched, or a live run would be retired under its own job."""
    stale = store.start_process_run("auto-archiver")
    with store.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "update process_runs set started_at = now() - %s where id = %s",
                (timedelta(hours=48), stale),
            )
        conn.commit()

    assert store.retire_stale_process_runs("auto-archiver", older_than_seconds=86400) == 1
    assert store.retire_stale_process_runs("auto-archiver", older_than_seconds=86400) == 0

    fresh = store.start_process_run("auto-archiver")
    assert store.retire_stale_process_runs("auto-archiver", older_than_seconds=3600) == 0

    runs = {run["id"]: run for run in store.list_process_runs()}
    assert runs[stale]["status"] == "aborted"
    assert runs[stale]["finished_at"] is not None
    assert runs[fresh]["status"] == "running"


def test_the_sweep_is_dated_by_the_boards_own_activity_clock(store):
    """`resume_board.updated_at` decides staleness - not `resumes.updated_at`, which the
    worker bumps on every status change (that is not operator activity)."""
    quiet = _seed_card(store, "sweep-quiet-1", quiet_days=30)
    _seed_card(store, "sweep-fresh-1", quiet_days=1)
    _seed_card(store, "sweep-prepare-1", stage="prepare", quiet_days=30)
    refused = _seed_card(store, "sweep-archived-1", quiet_days=30)
    with store.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "update resume_board set archived_at = now(), archived_actor = 'Candidate',"
                " archived_reason = 'Not applicable' where job_id = %s",
                (refused,),
            )
        conn.commit()

    assert [row["job_id"] for row in store.list_inactive_cards(("applied",), 10)] == [quiet]

    # The *resumes* clock says `now` for that very card: it must not matter at all.
    with store.connection() as conn:
        with conn.cursor() as cur:
            cur.execute("select updated_at from resumes where job_id = %s", (quiet,))
            resumes_updated = cur.fetchone()["updated_at"]
            cur.execute("select updated_at from resume_board where job_id = %s", (quiet,))
            board_updated = cur.fetchone()["updated_at"]
    assert resumes_updated > board_updated


def test_the_sweep_refuses_a_card_exactly_like_the_board_does(store):
    """Invariants 19 and 20 with no human behind them: the three archive columns together,
    one `kind='archive'` history row, the reason upserted into the vocabulary - and `stage`
    and `resumes.status` untouched. Re-running the sweep changes nothing."""
    job_id = _seed_card(store, "sweep-refuse-1", quiet_days=30)

    assert store.archive_card(job_id, "Company", "Radio silence") is True

    with store.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select stage, archived_actor, archived_reason,"
                " archived_at is not null as archived from resume_board where job_id = %s",
                (job_id,),
            )
            board = cur.fetchone()
            assert board["stage"] == "applied", "a refusal never moves the card"
            assert board["archived"] is True
            assert board["archived_actor"] == "Company"
            assert board["archived_reason"] == "Radio silence"

            cur.execute(
                "select kind, actor, action, from_state, to_state from resume_history"
                " where job_id = %s",
                (job_id,),
            )
            assert cur.fetchall() == [
                {
                    "kind": "archive",
                    "actor": "Company",
                    "action": "Radio silence",
                    "from_state": "active",
                    "to_state": "archived",
                }
            ]

            cur.execute("select kind, uses from board_actions where action = 'Radio silence'")
            assert cur.fetchone() == {"kind": "archive", "uses": 1}

            cur.execute("select status from resumes where job_id = %s", (job_id,))
            assert cur.fetchone()["status"] == "completed", "the worker's column is not ours"
        conn.commit()

    # Idempotent: an archived card is left alone and grows no second trail.
    assert store.archive_card(job_id, "Company", "Radio silence") is False
    with store.connection() as conn:
        with conn.cursor() as cur:
            cur.execute("select count(*) as n from resume_history where job_id = %s", (job_id,))
            assert cur.fetchone()["n"] == 1
            cur.execute("select uses from board_actions where action = 'Radio silence'")
            assert cur.fetchone()["uses"] == 1
        conn.commit()
