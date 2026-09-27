"""Job state store.

Two interchangeable backends:

* ``local``    - a JSON file under ``artifacts/`` (what the hermetic test suite
  uses, so it needs no database).
* ``postgres`` - the Postgres database the dashboard reads from. The worker
  writes status transitions here so the UI can show progress (doc: "worker
  updates PostgreSQL state").

The worker is single-threaded per pod (``prefetch_count = 1``), so one lazily
opened psycopg connection per process is enough.
"""

import json
import os
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

import config
from utils.logging_setup import get_logger

log = get_logger(__name__)


JOB_FIELDS = (
    "job_id",
    "user_id",
    "external_id",
    "title",
    "company",
    "source_url",
    "source",
    "description_raw",
    "cv_version",
    "status",
    "attempts",
    "revision_count",
    "is_approved",
    "error",
    "docx_path",
    "pdf_url",
    "duration_ms",
    "created_at",
    "updated_at",
)


def now_iso():
    return datetime.now(UTC).isoformat()


def job_key(user_id, external_id, cv_version="v1", source="djinni"):
    """Stable idempotency key: same vacancy + same CV version => same work.

    `source` belongs in the key because two sites number their vacancies
    independently: djinni's 848944 and DOU's 848944 are different vacancies, and
    without the site in the key one would look like a duplicate of the other
    (`resumes_job_key_idx`, and the board's Scraped intake).
    """
    return f"{user_id or 'local'}:{source or 'djinni'}:{external_id}:{cv_version or 'v1'}"


def new_job_id():
    return str(uuid.uuid4())


# The board's columns (`resume_board`, `resume_history`, `board_actions`) are Postgres
# tables and the JSON backend has no board at all, so the automation says so instead of
# pretending a run changed something (`archiver/run.py` preflights this as well).
BOARD_BACKEND_REQUIRED = (
    "the board's state lives in Postgres - run this with DB_BACKEND=postgres "
    "(the JSON backend stores jobs only)"
)


class LocalDb:
    """JSON-file job store used for local runs and tests."""

    backend = "local"

    def __init__(self, path=None):
        self.path = path or os.path.join(config.ARTIFACTS_DIR, "db_state.json")

    # -- plumbing ---------------------------------------------------------- #
    def ping(self):
        return True

    def _load(self):
        if os.path.exists(self.path):
            try:
                with open(self.path, encoding="utf-8") as handle:
                    return json.load(handle)
            except Exception as exc:  # noqa: BLE001
                log.warning("could not read local db", path=self.path, error=str(exc))
        return {"jobs": {}, "completed": {}, "cover_letters": {}}

    def _save(self, data):
        directory = os.path.dirname(self.path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        tmp_path = f"{self.path}.tmp"
        with open(tmp_path, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
        os.replace(tmp_path, self.path)

    # -- API --------------------------------------------------------------- #
    def upsert_job(self, job):
        """Claim the row for one task (see PostgresDb.upsert_job for semantics).

        Returns {"job_id": <effective row id>, "outcome": claimed|duplicate|owned}.
        """
        data = self._load()
        jobs = data["jobs"]
        job_id = str(job.get("job_id") or new_job_id())
        job = {**job, "job_id": job_id}
        key = job_key(
            job.get("user_id"),
            job.get("external_id"),
            job.get("cv_version"),
            job.get("source"),
        )

        existing = jobs.get(job_id)
        if existing is not None and (
            existing.get("external_id") != job.get("external_id")
            or (existing.get("source") or "djinni") != (job.get("source") or "djinni")
        ):
            log.warning(
                "job_id already belongs to another vacancy - refusing to reuse it",
                job_id=job_id,
                owner_external_id=existing.get("external_id"),
            )
            return {"job_id": job_id, "outcome": "owned", "row": existing}

        sibling = next(
            (
                row
                for row in jobs.values()
                if job_key(
                    row.get("user_id"),
                    row.get("external_id"),
                    row.get("cv_version"),
                    row.get("source"),
                )
                == key
            ),
            None,
        )
        if sibling is not None and sibling.get("status") in ACTIVE_STATUSES:
            log.info(
                "vacancy already claimed - treating this message as a duplicate",
                job_id=sibling.get("job_id"),
                status=sibling.get("status"),
            )
            return {"job_id": sibling["job_id"], "outcome": "duplicate", "row": sibling}

        if sibling is not None:
            # Re-claim the row left behind by a failed/rate-limited attempt: the
            # business key is unique, so reuse the row instead of inserting.
            record = {
                **sibling,
                **{k: v for k, v in job.items() if k != "created_at"},
                "job_id": sibling["job_id"],
                "created_at": sibling.get("created_at") or now_iso(),
                "updated_at": now_iso(),
                "error": None,
            }
            record["attempts"] = max(
                int(sibling.get("attempts") or 0), int(job.get("attempts") or 0)
            )
            jobs[record["job_id"]] = record
            self._save(data)
            return {"job_id": record["job_id"], "outcome": "claimed", "row": record}

        record = {
            "created_at": now_iso(),
            **job,
            "attempts": int(job.get("attempts") or 0),
            "error": None,
            "updated_at": now_iso(),
        }
        record.setdefault("status", "queued")
        jobs[job_id] = record
        if record.get("status") == "completed":
            data["completed"][key] = job_id
        self._save(data)
        return {"job_id": job_id, "outcome": "claimed", "row": record}

    def upsert_cover_letter(
        self, job_id, status, text=None, model=None, error=None, attempts=0
    ):
        """Create/refresh the single cover-letter row of one vacancy (see PostgresDb)."""
        data = self._load()
        letters = data.setdefault("cover_letters", {})
        record = letters.get(job_id) or {
            "job_id": job_id,
            "text": None,
            "model": None,
            "attempts": 0,
            "created_at": now_iso(),
        }
        record["status"] = status
        record["error"] = error
        if text:
            record["text"] = text
        if model:
            record["model"] = model
        record["attempts"] = max(int(record.get("attempts") or 0), int(attempts or 0))
        record["updated_at"] = now_iso()
        letters[job_id] = record
        self._save(data)
        return record

    def get_cover_letter(self, job_id):
        return self._load().get("cover_letters", {}).get(job_id)

    def update_job(self, job_id, **fields):
        data = self._load()
        record = data["jobs"].get(job_id)
        if record is None:
            return None
        record.update({k: v for k, v in fields.items() if k in JOB_FIELDS or k == "note"})
        record["updated_at"] = now_iso()
        if record.get("status") == "completed":
            data["completed"][
                job_key(
                    record.get("user_id"),
                    record.get("external_id"),
                    record.get("cv_version"),
                    record.get("source"),
                )
            ] = job_id
        data["jobs"][job_id] = record
        self._save(data)
        return record

    def find_existing_ids(self, source, external_ids, cv_version="v1"):
        """Which of these vacancies are already on the board (see PostgresDb)."""
        wanted = set(external_ids)
        source = source or "djinni"
        cv_version = cv_version or "v1"
        return {
            row.get("external_id")
            for row in self._load()["jobs"].values()
            if row.get("external_id") in wanted
            and (row.get("source") or "djinni") == source
            and (row.get("cv_version") or "v1") == cv_version
        }

    def app_user_exists(self, user_id):
        """The file backend has no `app_users`: accounts are a Postgres/backoffice concern."""
        return True

    def get_job(self, job_id):
        return self._load()["jobs"].get(job_id)

    def find_completed(self, key):
        data = self._load()
        job_id = data["completed"].get(key)
        if not job_id:
            return None
        return data["jobs"].get(job_id)

    def increment_attempts(self, job_id):
        record = self.get_job(job_id) or {}
        attempts = int(record.get("attempts") or 0) + 1
        self.update_job(job_id, attempts=attempts)
        return attempts

    def list_jobs(self, limit=50):
        jobs = list(self._load()["jobs"].values())
        return sorted(jobs, key=lambda j: j.get("created_at") or "", reverse=True)[:limit]

    # -- the internal process ledger (see PostgresDb) ----------------------- #
    def start_process_run(self, process, trigger="schedule"):
        """Open one run record for a scheduled job; returns its id.

        Kept in the same JSON file (``data["process_runs"]``) so the ledger is testable
        without a database - the scout's and the archiver's hermetic tests assert on it.
        """
        data = self._load()
        runs = data.setdefault("process_runs", [])
        run_id = max((int(row.get("id") or 0) for row in runs), default=0) + 1
        runs.append(
            {
                "id": run_id,
                "process": process,
                "trigger": trigger,
                "started_at": now_iso(),
                "finished_at": None,
                "status": "running",
                "summary": None,
                "error": None,
            }
        )
        self._save(data)
        return run_id

    def finish_process_run(self, run_id, status="ok", summary=None, error=None):
        """Close a run with its outcome and counters; an unknown id is ignored."""
        data = self._load()
        for row in data.get("process_runs", []):
            if int(row.get("id") or 0) == int(run_id):
                row["finished_at"] = now_iso()
                row["status"] = status
                row["summary"] = summary
                row["error"] = error
                self._save(data)
                return row
        return None

    def list_process_runs(self, limit=100):
        """Newest run first, whatever its status (the board's Processes window)."""
        runs = sorted(
            self._load().get("process_runs", []),
            key=lambda row: int(row.get("id") or 0),
            reverse=True,
        )
        return runs[: max(1, int(limit))]

    def retire_stale_process_runs(self, process, older_than_seconds=86400):
        """Mark the ``running`` rows a killed pod left behind as ``aborted``."""
        cutoff = datetime.now(UTC).timestamp() - float(older_than_seconds)
        data = self._load()
        retired = 0
        for row in data.get("process_runs", []):
            if row.get("process") != process or row.get("status") != "running":
                continue
            started = row.get("started_at")
            try:
                at = datetime.fromisoformat(started).timestamp()
            except (TypeError, ValueError):
                at = 0
            if at < cutoff:
                row["status"] = "aborted"
                row["finished_at"] = started
                retired += 1
        if retired:
            self._save(data)
        return retired

    # -- the inactivity archive (see PostgresDb) ---------------------------- #
    def list_inactive_cards(self, stages, older_than_days, limit=100):
        raise RuntimeError(BOARD_BACKEND_REQUIRED)

    def archive_card(self, job_id, actor, reason):
        raise RuntimeError(BOARD_BACKEND_REQUIRED)


# Statuses that mean "this vacancy is already being (or has been) handled".
# Anything else (failed / rate_limited / dead_lettered / skipped) may be
# re-claimed by a retry. Keep in sync with agent.contracts.JobStatus.
#
# `submitted` - the row the ingest gateway creates before publishing - is NOT here on
# purpose: an active sibling makes `_claim_row` ack the message as a duplicate, which
# would turn the gateway's own card into a no-op. Not being active makes the claim
# adopt that row (same job_id, status -> processing) instead.
ACTIVE_STATUSES = ("queued", "processing", "rendering", "validating", "uploading", "completed")

# job_id is an OPAQUE CLIENT-SUPPLIED STRING (design decision "option A"):
# the gateway may send `848944-1789668742`, a UUID, or anything else sane - it is
# the row identity, not a business key. Uniqueness comes from the primary key and
# the shape guard below stops nonsense reaching the table. The business identity
# (user_id, source, external_id, cv_version) is enforced separately by
# `resumes_job_key_idx`.
SCHEMA_SQL = """
create table if not exists resumes (
    job_id          text primary key,
    user_id         text,
    external_id     text not null,
    -- Which site the vacancy came from ('djinni', 'dou', ...). Part of the business key:
    -- two sites number their vacancies independently, so the number alone cannot tell
    -- "the same vacancy" from "two vacancies that happen to share a number".
    source          text not null default 'djinni',
    title           text,
    company         text,
    source_url      text,
    -- The job description as plain text. The queue message carries it for the tailoring
    -- task, but a cover letter may be asked for days later - then this is the only copy.
    -- Null for rows created before 2026-09-26 and whenever a publisher had none; such a
    -- card cannot generate a cover letter until it is scraped again.
    description_raw text,
    cv_version      text not null default 'v1',
    -- 'queued' is only a *default*: the ingest gateway (backoffice batch route)
    -- creates the row with 'submitted' before it publishes, so the worker's claim
    -- adopts it (see ACTIVE_STATUSES above).
    status          text not null default 'queued',
    attempts        integer not null default 0,
    revision_count  integer,
    is_approved     boolean,
    error           text,
    docx_path       text,
    pdf_url         text,
    duration_ms     integer,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

-- Before the index below: Postgres resolves the columns an index names even when
-- `if not exists` makes the statement a no-op, so a legacy table without `source` would
-- fail right here. Both columns are part of the 2026-09-26 rework.
alter table resumes add column if not exists source text not null default 'djinni';
alter table resumes add column if not exists description_raw text;

create unique index if not exists resumes_job_key_idx
    on resumes (coalesce(user_id, 'local'), source, external_id, cv_version);

create table if not exists model_availability (
    name        text primary key,
    reason      text,
    recorded_at timestamptz not null default now()
);

create table if not exists app_settings (
    key        text primary key,
    value      jsonb,
    updated_at timestamptz not null default now()
);

-- Board-owned state for the backoffice kanban (`backoffice/`). The worker never
-- touches these tables, and the board never writes `resumes.status`: that column is
-- the worker's claim/idempotency state (see ACTIVE_STATUSES), so the board's
-- `prepare` sub-state is *derived* from it instead of stored.
--
-- `archived_*` is the board's **in-place soft delete**: a refused vacancy keeps its
-- `stage`, so the funnel still shows where the application dropped out, and only the
-- card's presentation is muted. The three columns are null together or set together
-- (guard below), which is what makes "archive" and "restore" single-column updates.
create table if not exists resume_board (
    job_id          text primary key references resumes (job_id) on delete cascade,
    stage           text not null default 'scraped',
    archived_at     timestamptz,
    archived_actor  text,
    archived_reason text,
    -- Operator-maintained vacancy details, editable on the card itself: who the recruiter
    -- is, what the employer offers, what the operator asks for, and where the conversation
    -- happens. Free text except the channels (a fixed vocabulary, enforced below); empty
    -- values are NULL, never ''.
    recruiter              text,
    salary_offered         text,
    salary_desired         text,
    communication_channels text[],
    updated_at      timestamptz not null default now()
);

-- Databases created before the archive feature need the columns added in place.
alter table resume_board add column if not exists archived_at timestamptz;
alter table resume_board add column if not exists archived_actor text;
alter table resume_board add column if not exists archived_reason text;

-- ... and the ones created before the card's own detail fields (2026-09-27).
alter table resume_board add column if not exists recruiter text;
alter table resume_board add column if not exists salary_offered text;
alter table resume_board add column if not exists salary_desired text;
alter table resume_board add column if not exists communication_channels text[];

-- The source + Scraped rework (2026-09-26): `source` joins the business key, the job
-- description becomes durable, and the board's intake column is `scraped` while the former
-- `created` column is the `prepare` one (a card is tailored only once the operator drags it
-- there). Every statement is idempotent: after the first boot nothing matches any more.
-- (`resumes.source` / `description_raw` are added next to the table above: the business-key
-- index resolves them further down.)
alter table resume_board alter column stage set default 'scraped';
update resume_board set stage = 'prepare' where stage = 'created';

-- Rows that predate the Scraped column have no board row of their own, so they would read as
-- `scraped` through the join's default. Anything that was queued or tailored already belongs to
-- Prepare - that is the column meaning "tailoring was requested" (found live on 2026-09-26).
insert into resume_board (job_id, stage)
select job_id, 'prepare'
  from resumes
 where status in ('queued', 'processing', 'rendering', 'validating', 'uploading',
                  'completed', 'skipped')
on conflict (job_id) do nothing;

-- Guarded: on a fresh database `resume_history` is created further down this script, so the
-- vocabulary rewrite has to wait until the table exists.
do $ddl$
begin
    if to_regclass('public.resume_history') is not null then
        update resume_history set from_state = 'prepare' where from_state = 'created';
        update resume_history set to_state = 'prepare' where to_state = 'created';
    end if;
end $ddl$;

create table if not exists resume_history (
    id         bigserial primary key,
    job_id     text not null references resumes (job_id) on delete cascade,
    at         timestamptz not null default now(),
    -- The dialog's Actor dropdown stores 'Candidate' | 'Company'. Rows written before
    -- 2026-09-26 say 'Me' | 'Them' and are migrated by the guarded block below.
    actor      text not null check (actor in ('Candidate', 'Company')),
    action     text not null check (char_length(action) between 1 and 500),
    -- 'archive'/'restore' are the board's soft-delete transitions; from_state/to_state
    -- are 'active'|'archived' for those, a stage id for 'move'.
    kind       text not null check (kind in ('move', 'tailoring', 'archive', 'restore')),
    from_state text not null,
    to_state   text not null
);

create index if not exists resume_history_job_id_at_idx on resume_history (job_id, at);

-- Cover letters, generated on demand (one row per vacancy). Owned by the cover worker
-- (`cover.py`), requested by the board, read by both. `text` is the letter as plain text and
-- `model` records which model actually wrote it, because the ladder may have moved since the
-- request; a removed vacancy takes its letter with it (cascade).
create table if not exists resume_cover_letter (
    job_id     text primary key references resumes (job_id) on delete cascade,
    status     text not null default 'queued',
    text       text,
    model      text,
    error      text,
    attempts   integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- The Action vocabulary the dialogs offer as a combobox and the Filters dialog
-- lists. It is *data*, not a code enum: typing a new action in a dialog persists it
-- here (one upsert inside the same transaction as the change), so the operator's own
-- wording is suggested next time. `kind` only decides what a dialog shows first.
create table if not exists board_actions (
    action       text primary key check (char_length(action) between 1 and 500),
    kind         text not null default 'archive' check (kind in ('archive', 'move')),
    uses         integer not null default 0,
    created_at   timestamptz not null default now(),
    last_used_at timestamptz not null default now()
);

-- Starting vocabulary; the operator extends it by typing. `do nothing` keeps the
-- counters intact when the worker boots against an existing database.
insert into board_actions (action, kind) values
    ('Salary mismatch', 'archive'),
    ('Rejected by company', 'archive'),
    ('No response', 'archive'),
    ('Position closed', 'archive'),
    ('Withdrawn by me', 'archive'),
    ('Location mismatch', 'archive'),
    ('Other', 'archive'),
    ('Applied via portal', 'move'),
    ('Referral', 'move'),
    ('Recruiter reached out', 'move'),
    ('Take-home sent', 'move')
on conflict (action) do nothing;


-- Interviews of one vacancy. The Interviews section of the card is its **own** record and
-- is deliberately *not* historicised in `resume_history`: the list in the section is the
-- history, so editing a date, a type or a result never grows the audit trail
-- (`CONSTITUTION.md` invariant 26). A card's first interview is inserted in the same
-- transaction as the move into `interviewing`; the section's visibility is derived from the
-- history (`hasReachedInterviewing`), so a vacancy that later moves on to `offer` keeps the
-- interviews it had. The four types are code + this CHECK, exactly like the Actors.
create table if not exists resume_interview (
    id           bigserial primary key,
    job_id       text not null references resumes (job_id) on delete cascade,
    scheduled_at timestamptz not null,
    type         text not null check (type in ('Initial Interview', 'Technical Interview',
                                               'Management Interview', 'Final Interview')),
    -- Free text the operator fills in after the interview; the section shows it as the
    -- interview's outcome. Length-capped the way `resume_history.action` is.
    result       text check (result is null or char_length(result) <= 2000),
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

create index if not exists resume_interview_job_id_at_idx on resume_interview (job_id, scheduled_at);


-- Artifacts queued for deletion from the worker's volume.
--
-- A board that runs outside the cluster (the dev setup) cannot reach `/data/output`, so
-- "remove this vacancy completely" has two halves: the board deletes what it can see and
-- records every stored path it could not, and `scripts/storage-files.ps1 -Action purge`
-- finishes the sweep inside the `cv-files` pod and clears the rows here. No foreign key to
-- `resumes` on purpose - the card is already gone when these rows exist.
create table if not exists artifact_purge (
    stored_path text primary key,
    job_id      text not null,
    queued_at   timestamptz not null default now()
);

-- Backoffice accounts. There is NO public signup: an administrator provisions
-- users out of band (`backoffice/scripts/user.mjs`) exactly like the design's
-- "manual provisioning" rule; the UI only ever authenticates.
create table if not exists app_users (
    id            text primary key,
    email         text not null unique,
    display_name  text,
    password_hash text not null,
    is_admin      boolean not null default false,
    is_active     boolean not null default true,
    created_at    timestamptz not null default now(),
    last_login_at timestamptz
);

-- The internal process run ledger: one row per run of a scheduled job (the RSS intake,
-- the inactivity archiver), written by the job itself and read by the board's Processes
-- window. It is the only place a run's history exists - the worker's `resumes` rows say
-- nothing about a run that found nothing. A row still `running` without `finished_at` means
-- the pod died mid-run; a later run marks those `aborted` (`utils/process_runs.py`).
create table if not exists process_runs (
    id          bigserial primary key,
    -- The job's slug (`feed-parser`, `auto-archiver`) - the same shape rule as
    -- `resumes.source`, because it is both queried and shown.
    process     text not null check (process ~ '^[a-z0-9][a-z0-9-]{1,31}$'),
    -- A CronJob slot, or a human `--force` run.
    trigger     text not null default 'schedule' check (trigger in ('schedule', 'manual')),
    started_at  timestamptz not null default now(),
    finished_at timestamptz,
    status      text not null default 'running'
                check (status in ('running', 'ok', 'failed', 'skipped', 'aborted')),
    -- The counters a run wants to show (`{"new_cards": 3, "notified": 3}`). jsonb, so a new
    -- job needs no migration - and a run that reports nothing is still a run.
    summary     jsonb,
    error       text
);

create index if not exists process_runs_process_started_idx on process_runs (process, started_at desc);

-- Shape guard for the opaque job_id (characters that are safe in logs, storage
-- keys and URLs). Added idempotently so existing tables get it too.
do $ddl$
begin
    if not exists (select 1 from pg_constraint where conname = 'resumes_job_id_shape') then
        alter table resumes
            add constraint resumes_job_id_shape
            check (char_length(job_id) between 4 and 80
                   and job_id !~ '[^A-Za-z0-9_.:-]');
    end if;
end $ddl$;

-- The source is a slug, not free text: it ends up in the business key.
do $ddl$
begin
    if not exists (select 1 from pg_constraint where conname = 'resumes_source_shape') then
        alter table resumes
            add constraint resumes_source_shape
            check (source ~ '^[a-z0-9][a-z0-9-]{1,31}$');
    end if;
end $ddl$;

-- A database that predates `source` still carries the three-column unique index; rebuild it
-- once, so the enforced business key is the one the code claims.
do $ddl$
declare
    definition text;
begin
    select indexdef into definition from pg_indexes where indexname = 'resumes_job_key_idx';
    if definition is not null and position('source' in definition) = 0 then
        drop index resumes_job_key_idx;
        definition := null;
    end if;
    if definition is null then
        create unique index resumes_job_key_idx
            on resumes (coalesce(user_id, 'local'), source, external_id, cv_version);
    end if;
end $ddl$;

-- The card's detail fields are free text with the same length cap the dialogs enforce, and
-- the channels are a vocabulary (the six the multi-select offers: two of them are the job sites
-- the intake scrapes). A NULL *element* is rejected too: `arr <@ known` is NULL for such an
-- array, and a CHECK is satisfied by NULL, so the containment is wrapped in `coalesce(..., false)`.
do $ddl$
begin
    if not exists (select 1 from pg_constraint where conname = 'resume_board_details_shape') then
        alter table resume_board
            add constraint resume_board_details_shape
            check (
                (recruiter is null or char_length(recruiter) between 1 and 200)
                and (salary_offered is null or char_length(salary_offered) between 1 and 200)
                and (salary_desired is null or char_length(salary_desired) between 1 and 200)
                and (communication_channels is null
                     or coalesce(communication_channels <@ array['Email', 'LinkedIn', 'WhatsApp',
                                                                  'Telegram', 'Dou', 'Djinni'],
                                 false))
            );
    end if;
end $ddl$;

-- Archiving is all-or-nothing: a row cannot claim to be refused without an actor and
-- a reason, and both must satisfy what the dialogs can send.
do $ddl$
begin
    if not exists (select 1 from pg_constraint where conname = 'resume_board_archive_shape') then
        alter table resume_board
            add constraint resume_board_archive_shape
            check ((archived_at is null) = (archived_actor is null)
                   and (archived_at is null) = (archived_reason is null)
                   and (archived_actor is null or archived_actor in ('Candidate', 'Company'))
                   and (archived_reason is null
                        or char_length(archived_reason) between 1 and 500));
    end if;
end $ddl$;

-- Vocabulary migrations for databases created before 2026-09-26: the Actor dropdown
-- stored 'Me'/'Them', and the history only knew 'move'/'tailoring'. Both are rewritten
-- in place, guard-first, so re-running this is a no-op.
do $ddl$
begin
    if exists (select 1 from pg_constraint
                where conname = 'resume_history_actor_check'
                  and pg_get_constraintdef(oid) like '%''Me''%') then
        alter table resume_history drop constraint resume_history_actor_check;
        update resume_history set actor = 'Candidate' where actor = 'Me';
        update resume_history set actor = 'Company' where actor = 'Them';
        alter table resume_history
            add constraint resume_history_actor_check
            check (actor in ('Candidate', 'Company'));
    end if;

    if exists (select 1 from pg_constraint
                where conname = 'resume_history_kind_check'
                  and pg_get_constraintdef(oid) not like '%archive%') then
        alter table resume_history drop constraint resume_history_kind_check;
        alter table resume_history
            add constraint resume_history_kind_check
            check (kind in ('move', 'tailoring', 'archive', 'restore'));
    end if;
end $ddl$;
"""


class PostgresDb:
    """Postgres job store."""

    backend = "postgres"

    def __init__(self, dsn=None):
        self.dsn = dsn or self._build_dsn()
        self._conn = None
        self._schema_ready = False

    @staticmethod
    def _build_dsn():
        dsn = config.DATABASE_URL
        if not dsn:
            raise RuntimeError(
                "DATABASE_URL is not set (required when DB_BACKEND=postgres)"
            )
        if config.DATABASE_SSLMODE and "sslmode=" not in dsn:
            separator = "&" if "?" in dsn else "?"
            dsn = f"{dsn}{separator}sslmode={config.DATABASE_SSLMODE}"
        return dsn

    # -- plumbing ---------------------------------------------------------- #
    @contextmanager
    def connection(self):
        """Yield the shared connection; roll back on failure.

        The worker processes one message at a time, so a single long-lived
        connection is intentional (avoids a TLS handshake per task).
        """
        import psycopg
        from psycopg.rows import dict_row

        if self._conn is None or getattr(self._conn, "closed", False):
            # A *pooled* endpoint (pgbouncer, transaction mode) cannot use
            # server-side prepared statements, so they are opt-in
            # (DB_PREPARE_STATEMENTS=true for a direct/session connection).
            prepare_threshold = (
                config.DB_PREPARE_THRESHOLD if config.DB_PREPARE_STATEMENTS else None
            )
            self._conn = psycopg.connect(
                self.dsn,
                row_factory=dict_row,
                autocommit=False,
                connect_timeout=15,
                prepare_threshold=prepare_threshold,
                application_name=config.DB_APPLICATION_NAME,
            )
        try:
            yield self._conn
        except Exception:
            try:
                self._conn.rollback()
            except Exception:  # noqa: BLE001
                pass
            raise

    def ping(self):
        with self.connection() as conn:
            with conn.cursor() as cur:
                cur.execute("select 1 as ok")
                cur.fetchone()
        self.ensure_schema()
        return True

    def ensure_schema(self):
        if self._schema_ready:
            return
        with self.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(SCHEMA_SQL)
            conn.commit()
        self._schema_ready = True

    # -- API --------------------------------------------------------------- #
    def upsert_job(self, job):
        """Claim the row for one task.

        Returns {"job_id": <effective row id>, "outcome": ...}:

        * ``claimed``   - this task owns the row; do the work;
        * ``duplicate`` - another (in-flight or completed) task already owns this
          vacancy + CV version, so the message can be acked;
        * ``owned``     - the supplied job_id belongs to a *different* vacancy,
          so the caller must not touch that row.
        """
        self.ensure_schema()
        payload = self._claim_payload(job)
        try:
            with self.connection() as conn:
                with conn.cursor() as cur:
                    result = self._claim_row(cur, payload)
                conn.commit()
            return result
        except Exception as exc:  # noqa: BLE001
            from psycopg.errors import UniqueViolation

            if not isinstance(exc, UniqueViolation):
                raise
            # Lost the race with another pod for the same vacancy: that task owns
            # it now, so this message is a safe duplicate.
            log.warning("lost a claim race - treating the message as a duplicate")
            return self._existing_claim(payload)

    @staticmethod
    def _claim_payload(job):
        return {
            "job_id": str(job.get("job_id") or new_job_id()),
            "user_id": job.get("user_id"),
            "external_id": job["external_id"],
            "source": job.get("source") or "djinni",
            "title": job.get("title"),
            "company": job.get("company"),
            "source_url": job.get("source_url"),
            "description_raw": job.get("description_raw"),
            "cv_version": job.get("cv_version") or "v1",
            "status": job.get("status") or "processing",
            "attempts": int(job.get("attempts") or 0),
        }

    def _claim_row(self, cur, payload):
        """Steps 1-3 of the claim; runs inside a transaction."""
        # 1. Same job_id but a different vacancy -> a foreign row: hands off.
        cur.execute(
            "select job_id, external_id, source, status, pdf_url from resumes where job_id = %s",
            (payload["job_id"],),
        )
        existing = cur.fetchone()
        if existing is not None and (
            existing["external_id"] != payload["external_id"]
            or existing["source"] != payload["source"]
        ):
            log.warning(
                "job_id already belongs to another vacancy - refusing to reuse it",
                job_id=payload["job_id"],
                owner_external_id=existing["external_id"],
                owner_source=existing["source"],
            )
            return {
                "job_id": str(existing["job_id"]),
                "outcome": "owned",
                "row": dict(existing),
            }

        sibling = self._find_by_business_key(cur, payload)

        # 2. Same vacancy already active/completed -> duplicate delivery.
        if sibling is not None and sibling["status"] in ACTIVE_STATUSES:
            log.info(
                "vacancy already claimed - treating this message as a duplicate",
                job_id=str(sibling["job_id"]),
                status=sibling["status"],
            )
            return {
                "job_id": str(sibling["job_id"]),
                "outcome": "duplicate",
                "row": dict(sibling),
            }

        # 3. Re-claim the row left by a failed attempt, otherwise insert a fresh
        #    one: resumes_job_key_idx is unique, so a second insert cannot work.
        if sibling is not None:
            cur.execute(
                """
                update resumes
                   set status = %(status)s,
                       attempts = greatest(attempts, %(attempts)s),
                       error = null,
                       description_raw = coalesce(%(description_raw)s, description_raw),
                       updated_at = now()
                 where job_id = %(row_id)s
                returning job_id, status
                """,
                {
                    "row_id": sibling["job_id"],
                    "status": payload["status"],
                    "attempts": payload["attempts"],
                    "description_raw": payload.get("description_raw"),
                },
            )
        else:
            cur.execute(
                """
                insert into resumes (job_id, user_id, external_id, source, title, company,
                                     source_url, description_raw, cv_version, status, attempts)
                values (%(job_id)s, %(user_id)s, %(external_id)s, %(source)s, %(title)s,
                        %(company)s, %(source_url)s, %(description_raw)s, %(cv_version)s,
                        %(status)s, %(attempts)s)
                on conflict (job_id) do update
                    set status = excluded.status,
                        attempts = greatest(resumes.attempts, excluded.attempts),
                        error = null,
                        description_raw = coalesce(excluded.description_raw,
                                                   resumes.description_raw),
                        updated_at = now()
                returning job_id, status
                """,
                payload,
            )

        row = cur.fetchone()
        return {
            "job_id": str(row["job_id"]) if row else payload["job_id"],
            "outcome": "claimed",
        }

    def _existing_claim(self, payload):
        with self.connection() as conn:
            with conn.cursor() as cur:
                sibling = self._find_by_business_key(cur, payload)
        return {
            "job_id": str(sibling["job_id"]) if sibling else payload["job_id"],
            "outcome": "duplicate",
            "row": dict(sibling) if sibling else None,
        }

    @staticmethod
    def _find_by_business_key(cur, payload):
        """The row (any status) that already owns this vacancy + CV version."""
        cur.execute(
            """
            select job_id, status, pdf_url from resumes
            where coalesce(user_id, 'local') = coalesce(%(user_id)s, 'local')
              and source = %(source)s
              and external_id = %(external_id)s
              and cv_version = %(cv_version)s
            limit 1
            """,
            payload,
        )
        return cur.fetchone()

    def upsert_cover_letter(
        self, job_id, status, text=None, model=None, error=None, attempts=0
    ):
        """Create/refresh the single cover-letter row of one vacancy.

        `text`/`model` are only overwritten when the caller has them, so a failed retry cannot
        wipe a letter that is already there; `attempts` only ever grows.
        """
        self.ensure_schema()
        with self.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    insert into resume_cover_letter
                        (job_id, status, text, model, error, attempts)
                    values (%(job_id)s, %(status)s, %(text)s, %(model)s, %(error)s,
                            %(attempts)s)
                    on conflict (job_id) do update
                        set status = excluded.status,
                            text = coalesce(excluded.text, resume_cover_letter.text),
                            model = coalesce(excluded.model, resume_cover_letter.model),
                            error = excluded.error,
                            attempts = greatest(resume_cover_letter.attempts,
                                                excluded.attempts),
                            updated_at = now()
                    returning *
                    """,
                    {
                        "job_id": job_id,
                        "status": status,
                        "text": text,
                        "model": model,
                        "error": error,
                        "attempts": int(attempts or 0),
                    },
                )
                row = cur.fetchone()
            conn.commit()
        return dict(row) if row else None

    def get_cover_letter(self, job_id):
        self.ensure_schema()
        with self.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "select * from resume_cover_letter where job_id = %s", (job_id,)
                )
                row = cur.fetchone()
        return dict(row) if row else None

    def update_job(self, job_id, **fields):
        if not fields:
            return None
        self.ensure_schema()
        allowed = {k: v for k, v in fields.items() if k in JOB_FIELDS}
        if not allowed:
            return None
        assignments = ", ".join(f"{name} = %({name})s" for name in allowed)
        params = {**allowed, "job_id": job_id}
        with self.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"update resumes set {assignments}, updated_at = now() "
                    "where job_id = %(job_id)s returning *",
                    params,
                )
                row = cur.fetchone()
            conn.commit()
        return dict(row) if row else None

    def find_existing_ids(self, source, external_ids, cv_version="v1"):
        """Which of these vacancies the board already has - **any** owner, any status.

        Board-scoped on purpose (`CONSTITUTION.md` invariant 17): the board renders every row
        whatever its `user_id`, so a lookup limited to one account would create a second card
        for a vacancy the operator can already see. The intake uses this to decide what is new;
        a refused card counts as known, so a re-run never reopens it.
        """
        if not external_ids:
            return set()
        self.ensure_schema()
        with self.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    select external_id from resumes
                     where source = %s
                       and external_id = any(%s)
                       and cv_version = %s
                    """,
                    (source or "djinni", list(external_ids), cv_version or "v1"),
                )
                return {row["external_id"] for row in cur.fetchall()}

    def app_user_exists(self, user_id):
        """True when `app_users` holds this id - the scout refuses to write as a stranger."""
        if not user_id:
            return False
        self.ensure_schema()
        with self.connection() as conn:
            with conn.cursor() as cur:
                cur.execute("select 1 as ok from app_users where id = %s", (user_id,))
                return cur.fetchone() is not None

    def get_job(self, job_id):
        self.ensure_schema()
        with self.connection() as conn:
            with conn.cursor() as cur:
                cur.execute("select * from resumes where job_id = %s", (job_id,))
                row = cur.fetchone()
        return dict(row) if row else None

    def find_completed(self, key):
        """Return an existing *completed* row for the idempotency key."""
        self.ensure_schema()
        user_id, source, external_id, cv_version = key.split(":", 3)
        with self.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    select * from resumes
                    where coalesce(user_id, 'local') = %s
                      and source = %s
                      and external_id = %s
                      and cv_version = %s
                      and status = 'completed'
                    limit 1
                    """,
                    (user_id, source, external_id, cv_version),
                )
                row = cur.fetchone()
        return dict(row) if row else None

    def increment_attempts(self, job_id):
        self.ensure_schema()
        with self.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "update resumes set attempts = attempts + 1, updated_at = now() "
                    "where job_id = %s returning attempts",
                    (job_id,),
                )
                row = cur.fetchone()
            conn.commit()
        return int(row["attempts"]) if row else 0

    def list_jobs(self, limit=50):
        self.ensure_schema()
        with self.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "select * from resumes order by created_at desc limit %s", (limit,)
                )
                rows = cur.fetchall()
        return [dict(row) for row in rows]

    # -- the internal process ledger ---------------------------------------- #
    def start_process_run(self, process, trigger="schedule"):
        """Open one run record for a scheduled job; returns its row id.

        The board's Processes window reads these rows, so a run that changed nothing is
        still visible. A row left ``running`` (the pod was killed) is retired by the next
        run of the same job (`retire_stale_process_runs`).
        """
        self.ensure_schema()
        with self.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "insert into process_runs (process, trigger) values (%s, %s) returning id",
                    (process, trigger),
                )
                row = cur.fetchone()
            conn.commit()
        return int(row["id"])

    def finish_process_run(self, run_id, status="ok", summary=None, error=None):
        """Close a run with its outcome and the counters the window shows."""
        self.ensure_schema()
        payload = None if summary is None else json.dumps(summary, ensure_ascii=False)
        with self.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    update process_runs
                       set finished_at = now(), status = %s, summary = %s::jsonb, error = %s
                     where id = %s
                    """,
                    (status, payload, error, int(run_id)),
                )
            conn.commit()

    def list_process_runs(self, limit=100):
        """Newest run first, whatever its status."""
        self.ensure_schema()
        with self.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """select id, process, trigger, started_at, finished_at, status,
                              summary, error
                         from process_runs
                        order by started_at desc, id desc
                        limit %s""",
                    (max(1, int(limit)),),
                )
                rows = cur.fetchall()
        return [dict(row) for row in rows]

    def retire_stale_process_runs(self, process, older_than_seconds=86400):
        """Mark the ``running`` rows a killed pod left behind as ``aborted``.

        Without this a crashed run would look in-flight forever and the window would show
        a job that never finishes. The age bound is what keeps a *live* run safe.
        """
        self.ensure_schema()
        with self.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    update process_runs
                       set status = 'aborted', finished_at = started_at
                     where process = %s
                       and status = 'running'
                       and started_at < now() - %s
                    """,
                    (process, timedelta(seconds=float(older_than_seconds))),
                )
                retired = cur.rowcount or 0
            conn.commit()
        return int(retired)

    # -- the inactivity archive (the `archiver` job) ------------------------- #
    def list_inactive_cards(self, stages, older_than_days, limit=100):
        """Cards in `stages` that no *operator action* has touched for N days.

        The clock is `resume_board.updated_at` - the field the board dates a card by and
        bumps on every move, archive, restore and recorded action. `resumes.updated_at` is
        deliberately not used: the worker writes status changes there, so a tailoring run
        would look like operator activity. Archived cards are never candidates.
        """
        self.ensure_schema()
        if not stages:
            return []
        with self.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    select r.job_id, r.external_id, r.source, r.title, r.company,
                           b.stage, b.updated_at
                      from resumes r
                      join resume_board b on b.job_id = r.job_id
                     where b.archived_at is null
                       and b.stage = any(%s)
                       and b.updated_at < now() - %s
                     order by b.updated_at asc
                     limit %s
                    """,
                    (list(stages), timedelta(days=int(older_than_days)), max(1, int(limit))),
                )
                rows = cur.fetchall()
        return [dict(row) for row in rows]

    def archive_card(self, job_id, actor, reason):
        """Refuse one card the way the board does, but with no human behind it.

        One transaction per card: the three archive columns together, the `kind='archive'`
        history row (`active` -> `archived`) and the Action-catalogue upsert - exactly the
        invariants the board's own archive route keeps (19, 20). `stage` is never touched
        (the card stays where it stopped, muted) and neither is `resumes.status`, which
        belongs to the worker alone.

        A card that is already archived is left alone, so re-running a sweep is safe.
        Returns True only when *this* call archived the card.
        """
        self.ensure_schema()
        with self.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    update resume_board
                       set archived_at = now(), archived_actor = %s, archived_reason = %s,
                           updated_at = now()
                     where job_id = %s and archived_at is null
                    returning job_id
                    """,
                    (actor, reason, job_id),
                )
                if cur.fetchone() is None:
                    conn.rollback()
                    return False
                cur.execute(
                    """
                    insert into resume_history
                        (job_id, actor, action, kind, from_state, to_state)
                    values (%s, %s, %s, 'archive', 'active', 'archived')
                    """,
                    (job_id, actor, reason),
                )
                cur.execute(
                    """
                    insert into board_actions (action, kind, uses) values (%s, 'archive', 1)
                    on conflict (action) do update
                        set uses = board_actions.uses + 1, last_used_at = now()
                    """,
                    (reason,),
                )
            conn.commit()
        return True


_DB_CACHE = {}


def get_db(backend=None):
    """Return the configured job store."""
    backend = (backend or config.DB_BACKEND or "local").strip().lower()
    if backend not in _DB_CACHE:
        if backend == "postgres":
            _DB_CACHE[backend] = PostgresDb()
        else:
            _DB_CACHE[backend] = LocalDb()
    return _DB_CACHE[backend]


def reset_db_cache():
    """Test helper: forget cached stores."""
    _DB_CACHE.clear()
