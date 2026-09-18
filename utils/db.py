"""Job state store.

Two interchangeable backends:

* ``local``    - a JSON file under ``artifacts/`` (keeps `python main.py` and
  the tests fully offline).
* ``postgres`` - the Supabase/Postgres database the dashboard reads from. The
  worker writes status transitions here, and Supabase Realtime pushes them to
  the UI (doc: "worker updates PostgreSQL state" -> "Realtime push").

The worker is single-threaded per pod (``prefetch_count = 1``), so one lazily
opened psycopg connection per process is enough.
"""

import json
import os
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime

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


def job_key(user_id, external_id, cv_version="v1"):
    """Stable idempotency key: same vacancy + same CV version => same work."""
    return f"{user_id or 'local'}:{external_id}:{cv_version or 'v1'}"


def new_job_id():
    return str(uuid.uuid4())


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
        return {"jobs": {}, "completed": {}}

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
        key = job_key(job.get("user_id"), job.get("external_id"), job.get("cv_version"))

        existing = jobs.get(job_id)
        if existing is not None and existing.get("external_id") != job.get("external_id"):
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
                if job_key(row.get("user_id"), row.get("external_id"), row.get("cv_version")) == key
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

    def update_job(self, job_id, **fields):
        data = self._load()
        record = data["jobs"].get(job_id)
        if record is None:
            return None
        record.update({k: v for k, v in fields.items() if k in JOB_FIELDS or k == "note"})
        record["updated_at"] = now_iso()
        if record.get("status") == "completed":
            data["completed"][
                job_key(record.get("user_id"), record.get("external_id"), record.get("cv_version"))
            ] = job_id
        data["jobs"][job_id] = record
        self._save(data)
        return record

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


# Statuses that mean "this vacancy is already being (or has been) handled".
# Anything else (failed / rate_limited / dead_lettered / skipped) may be
# re-claimed by a retry. Keep in sync with agent.contracts.JobStatus.
ACTIVE_STATUSES = ("queued", "processing", "rendering", "validating", "uploading", "completed")

# job_id is an OPAQUE CLIENT-SUPPLIED STRING (design decision "option A"):
# the gateway may send `848944-1789668742`, a UUID, or anything else sane - it is
# the row identity, not a business key. Uniqueness comes from the primary key and
# the shape guard below stops nonsense reaching the table. The business identity
# (user_id, external_id, cv_version) is enforced separately by
# `resumes_job_key_idx`.
SCHEMA_SQL = """
create table if not exists resumes (
    job_id          text primary key,
    user_id         text,
    external_id     text not null,
    title           text,
    company         text,
    source_url      text,
    cv_version      text not null default 'v1',
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

create unique index if not exists resumes_job_key_idx
    on resumes (coalesce(user_id, 'local'), external_id, cv_version);

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
"""


class PostgresDb:
    """Supabase/Postgres job store."""

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
            # Supabase's *pooled* endpoint (pgbouncer, transaction mode) cannot
            # use server-side prepared statements, so they are opt-in
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
            "title": job.get("title"),
            "company": job.get("company"),
            "source_url": job.get("source_url"),
            "cv_version": job.get("cv_version") or "v1",
            "status": job.get("status") or "processing",
            "attempts": int(job.get("attempts") or 0),
        }

    def _claim_row(self, cur, payload):
        """Steps 1-3 of the claim; runs inside a transaction."""
        # 1. Same job_id but a different vacancy -> a foreign row: hands off.
        cur.execute(
            "select job_id, external_id, status, pdf_url from resumes where job_id = %s",
            (payload["job_id"],),
        )
        existing = cur.fetchone()
        if existing is not None and existing["external_id"] != payload["external_id"]:
            log.warning(
                "job_id already belongs to another vacancy - refusing to reuse it",
                job_id=payload["job_id"],
                owner_external_id=existing["external_id"],
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
                       updated_at = now()
                 where job_id = %(row_id)s
                returning job_id, status
                """,
                {
                    "row_id": sibling["job_id"],
                    "status": payload["status"],
                    "attempts": payload["attempts"],
                },
            )
        else:
            cur.execute(
                """
                insert into resumes (job_id, user_id, external_id, title, company,
                                     source_url, cv_version, status, attempts)
                values (%(job_id)s, %(user_id)s, %(external_id)s, %(title)s,
                        %(company)s, %(source_url)s, %(cv_version)s, %(status)s,
                        %(attempts)s)
                on conflict (job_id) do update
                    set status = excluded.status,
                        attempts = greatest(resumes.attempts, excluded.attempts),
                        error = null,
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
              and external_id = %(external_id)s
              and cv_version = %(cv_version)s
            limit 1
            """,
            payload,
        )
        return cur.fetchone()

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
        user_id, external_id, cv_version = key.split(":", 2)
        with self.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    select * from resumes
                    where coalesce(user_id, 'local') = %s
                      and external_id = %s
                      and cv_version = %s
                      and status = 'completed'
                    limit 1
                    """,
                    (user_id, external_id, cv_version),
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
