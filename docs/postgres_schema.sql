-- Core schema for the CV tailoring platform.
-- Runs on any Postgres: the in-cluster instance, docker-compose, or a managed
-- service. Plain SQL only - no RLS, no extensions beyond gen_random_uuid().
--
-- The worker also runs `create table if not exists` on startup (utils/db.py),
-- so this file is the declarative source of truth, not a hard prerequisite.

-- --------------------------------------------------------------------------
-- One row per (vacancy, cv_version) tailoring job.
-- --------------------------------------------------------------------------
create table if not exists resumes (
    job_id          text primary key,
    user_id         text,
    external_id     text not null,             -- vacancy id from the source site
    title           text,
    company         text,
    source_url      text,
    cv_version      text not null default 'v1',
    status          text not null default 'queued',
    attempts        integer not null default 0,
    revision_count  integer,
    is_approved     boolean,
    error           text,
    docx_path       text,                       -- object key / url of the tailored DOCX
    pdf_url         text,                       -- signed url of the tailored PDF
    duration_ms     integer,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

-- Idempotency: the same vacancy + master CV version must never be paid for twice.
create unique index if not exists resumes_job_key_idx
    on resumes (coalesce(user_id, 'local'), external_id, cv_version);

create index if not exists resumes_status_idx on resumes (status);
create index if not exists resumes_created_at_idx on resumes (created_at desc);

-- job_id is an OPAQUE CLIENT-SUPPLIED STRING (it does not have to be a UUID):
-- it is the row identity, while (user_id, external_id, cv_version) above is the
-- business identity. This guard keeps nonsense out of the table; uniqueness is
-- enforced by the primary key.
do $ddl$
begin
    if not exists (select 1 from pg_constraint where conname = 'resumes_job_id_shape') then
        alter table resumes
            add constraint resumes_job_id_shape
            check (char_length(job_id) between 4 and 80
                   and job_id !~ '[^A-Za-z0-9_.:-]');
    end if;
end
$ddl$;

-- status values written by the worker:
--   queued, processing, rendering, validating, uploading,
--   completed, skipped, failed, rate_limited, dead_lettered

-- --------------------------------------------------------------------------
-- Model availability ledger (replaces the local model_state.json).
-- Shared by every worker pod and survives scale-to-zero.
-- --------------------------------------------------------------------------
create table if not exists model_availability (
    name        text primary key,
    reason      text,
    recorded_at timestamptz not null default now()
);

-- Generic key/value settings (holds the current model pointer).
create table if not exists app_settings (
    key        text primary key,
    value      jsonb,
    updated_at timestamptz not null default now()
);

-- --------------------------------------------------------------------------
-- Vacancies + applications (written by the Vercel gateway; read-only for us).
-- --------------------------------------------------------------------------
create table if not exists vacancies (
    id             uuid primary key default gen_random_uuid(),
    user_id        text,
    source         text,                        -- e.g. djinni
    external_id    text not null,
    title          text,
    company        text,
    source_url     text,
    description_raw text,
    parsed_at      timestamptz not null default now(),
    unique (source, external_id)
);

create table if not exists applications (
    id           uuid primary key default gen_random_uuid(),
    user_id      text,
    resume_id    text references resumes (job_id) on delete set null,
    status       text not null default 'pending',
    submitted_at timestamptz,
    created_at   timestamptz not null default now()
);

-- --------------------------------------------------------------------------
-- updated_at maintenance
-- --------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger as $fn$
begin
    new.updated_at = now();
    return new;
end;
$fn$ language plpgsql;

drop trigger if exists resumes_set_updated_at on resumes;
create trigger resumes_set_updated_at
    before update on resumes
    for each row execute function set_updated_at();
