# utils/ - adapters and infrastructure layer

Everything that talks to the outside world (broker, database, filesystem, LLM
transport, external binaries, logs) or performs low-level DOCX surgery. This layer
holds **no tailoring business logic** - it is called by `agent/` and the entry points.

Read `CONSTITUTION.md` first. Hard rule for this layer: **`utils/` must never
import `agent/`.** The dependency direction is `agent/` -> `utils/` -> `config`.

## The backend pattern (follow it for anything new)

Each provider-specific concern exposes one interface with interchangeable backends,
selected by an env var, reached through a cached factory with a test hook:

| Concern | Env var | Backends | Factory / test hook |
|---|---|---|---|
| Queue | `QUEUE_BACKEND` | `directory`, `amqp` | `messaging.get_queue()` / `reset_queue_cache()` |
| Job store | `DB_BACKEND` | `local`, `postgres` | `db.get_db()` / `reset_db_cache()` |
| Model ledger | `MODEL_STATE_BACKEND` | `file`, `postgres` | `model_state.get_store()` / `reset_store_cache()` |
| Artifacts | (none) | `LocalStorage` only | `storage.get_storage()` / `reset_storage_cache()` |

The `directory` / `local` / `file` values exist **only** for the hermetic test suite
(and per `CONSTITUTION.md` section 2 the cluster always runs amqp / postgres /
postgres). Keep them working - removing one means rewriting the tests that use it.

Call sites never branch on the backend. Every cache has a `reset_*` helper, and
`tests/helpers.reset_caches()` calls all of them - **if you add a cached factory,
add it there too.**

## Module map

| Module | Responsibility | Public surface |
|---|---|---|
| `logging_setup.py` | Structured logs (`text`/`json`) + the heartbeat file and the idle heartbeat thread every consumer starts | `get_logger`, `setup_logging`, `ContextLogger.bind`, `write_heartbeat`, `heartbeat_age_seconds`, `start_heartbeat_thread`, `HEARTBEAT_TICK_SECONDS`, `utc_now_iso` |
| `process_runs.py` | The **internal process ledger**: the job slugs (`feed-parser`, `auto-archiver`), the run statuses, and the `record(...)` context manager both scheduled jobs open one row with - always closed (a `--dry-run` writes nothing, a store that refuses is logged, never fatal), plus `retire_stale` for the rows a killed pod left `running`. Read by the board's Processes window | `FEED_PARSER`, `AUTO_ARCHIVER`, `record`, `close`, `retire_stale`, `RunRecord` |
| `candidate.py` | The candidate facts **every prompt** is grounded in (CV tailoring, cover letter, form): `FACTS`, `sanitize()` (known keys only; `MAX_VALUE_CHARS` for a fact, `MAX_ANSWER_CHARS` for a standing answer - a project deep-dive does not fit in a form field), `digest()` for the prompts, and `load(store, user_id)` reading the `application_profile` row - pure, and a missing row is never an error |
| `messaging.py` | Queue abstraction: `HandlerResult`/`Outcome`, `Delivery`, `DirectoryQueue`, `AmqpQueue`, retry ladder, DLQ. A queue is a **`QueueSpec`** (`task_queue_spec()` / `cover_queue_spec()` / `application_queue_spec()`), and `get_queue(backend, spec)` caches per (backend, queue) - so the two consumers in one process can never share an object. The file backend gives each spec its own directory, or one consumer would eat the other's messages. The AMQP heartbeat comes from `config.AMQP_HEARTBEAT_SECONDS` and must stay **above the longest task** - pika cannot service heartbeats while the graph runs | `get_queue`, `HandlerResult.ack/retry/retry_later/dead_letter`, `RETRY_LADDER_SECONDS` |
| `db.py` | Job store + claim semantics + schema DDL. `SCHEMA_SQL` is the **only** DDL and also creates the backoffice's tables - `resume_board` (with its archive columns *and* the card's own detail fields - recruiter, the two salaries, a `text[]` of channels), `resume_history` (four kinds, `Candidate`/`Company` actors), `board_actions`, `artifact_purge` (the volume sweep queue) `resume_cover_letter` (the cover worker's on-demand letters), `resume_interview` (the card's interviews - its own record, never historicised) and `app_users` (the backoffice shares this database); `process_runs` is the scheduled jobs' run ledger and `archive_card` is the one board write the Python side owns (the inactivity sweep, invariant 27). Guarded `do $ddl$` blocks upgrade an existing database in place (job-id shape, the source column and the business-key index, the stage vocabulary, archive shape, the actor rename, the kind list) | `get_db`, `job_key`, `new_job_id`, `JOB_FIELDS`, `SCHEMA_SQL`, `ACTIVE_STATUSES`, `upsert_cover_letter`, `get_cover_letter`, `start_process_run`, `finish_process_run`, `list_process_runs`, `retire_stale_process_runs`, `list_inactive_cards`, `archive_card` |
| `storage.py` | Local artifact IO + per-task materialisation | `get_storage`, `TaskContext`, `LocalStorage`, `output_key_for` |
| `model_state.py` | Model-availability ledger + fallback ladder | `init_model_state`, `advance_after_failure`, `next_available_model`, `preferred_available` |
| `retry.py` | Gemini backoff + quota handling | `retry_with_exponential_backoff`, `RetryLater`, `wait_until_midnight_utc` |
| `cv_text.py` | `cv_data.json` as text: loading (never cached), the string normalisers every matcher shares, and the single-line-per-paragraph render - the read-only projects block included | `load_cv_data`, `cv_data_to_text`, `extract_doc_text`, `project_lines`, `normalize_text`, `strip_leading_bullet`, `split_lines` |
| `cv_replacements.py` | What a proposed replacement must be (ONE clean line) and what it must never touch (the read-only projects block) | `normalize_replacements`, `read_only_lines`, `drop_read_only_replacements` |
| `docx_mutator.py` | The mechanical DOCX AST surgery: walk (nested tables included), check the model against the document, rewrite one line | `apply_text_replacements`, `validate_cv_data_against_docx`, `iter_all_paragraphs` |
| `renderer.py` | LibreOffice -> PDF -> PNG | `convert_docx_to_pdf`, `convert_pdf_to_images`, `render_tools_status`, `assert_render_tools_available` |

## Invariants and gotchas

- **`db.upsert_job()` returns an outcome**, not a boolean: `claimed` (do the work),
  `duplicate` (another task owns this vacancy - ack it), `owned` (the supplied
  `job_id` belongs to a different vacancy - do not touch the row). `ACTIVE_STATUSES`
  must stay in sync with `agent.contracts.JobStatus`.
- **`job_id` shape guard** is enforced twice: Pydantic at the edge and the
  `resumes_job_id_shape` CHECK in the SQL (opaque 4-80 char string, not a UUID).
- **Prepared statements are opt-in** (`DB_PREPARE_STATEMENTS`, default false)
  because a pooled endpoint (pgbouncer, transaction mode) cannot use them.
- **One long-lived psycopg connection per process** is intentional (the worker is
  single-threaded, `prefetch_count = 1`); `connection()` rolls back on failure.
- **`RetryLater` is the headless escape hatch.** A pod has no TTY, so quota
  exhaustion must never block on `input()`; it defers to a TTL retry queue instead.
- **The retry ladder is a constant**, `RETRY_LADDER_SECONDS`, not `QUEUE_RETRY_TTL_MS`
  - that env var/chart key is inert (`CONSTITUTION.md` D5).
- **Storage is local by design.** There is no `STORAGE_BACKEND`; the `supabase`
  value in the Dockerfile is dead (`CONSTITUTION.md` D1). A remote backend would
  implement `fetch_master_cv` / `fetch_cv_data` / `upload` and be chosen in `get_storage()`.
- **DOCX replacements must stay single-line** and bullet-free: `normalize_replacements()`
  splits/drops, and `apply_text_replacements()` skips any `original_text` with a newline.
  Matching normalises `\xa0` -> space and en/em dashes -> `-`.
- **The sync validator is a contract check**, not a convenience:
  `validate_cv_data_against_docx()` returns the lines it could not find (empty == in sync). It is
  **one-directional** - a section that exists only in the DOCX stays invisible until `cv_data.json`
  carries it - and it skips label lines (those ending in `:`).
- **`personal_projects` is context, not copy**: rendered into the CV text so the model can draw on
  it, and protected by `drop_read_only_replacements()` so no replacement can rewrite it. The
  `heading` is verbatim (tabs included) because the sync test is tab-preserving.
- **Renderer hardening**: one LibreOffice user profile per job
  (`-env:UserInstallation=...`), a hard timeout (`CONVERSION_TIMEOUT_SECONDS = 240`),
  and isolated output dirs, so two conversions on one node cannot fight over the
  default profile. The `docx2pdf` fallback is unproven (`CONSTITUTION.md` D6).
- **Logging fields**: pass structured extras (`log.info("msg", job_id=..., pages=n)`).
  `ContextLogger` renames keys that collide with `LogRecord` attributes.

## Adding a backend

1. Implement the same three-to-five methods as the existing class and set `backend`.
2. Extend the `get_*()` factory (and keep its cache).
3. Add the `reset_*` hook to `tests/helpers.reset_caches()`.
4. Add the env var to `config.py`, `.env.example` and (if it is a cluster knob)
   the chart's `values.yaml` + `configmap.yaml`.
