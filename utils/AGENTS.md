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

Call sites never branch on the backend. Every cache has a `reset_*` helper, and
`tests/helpers.reset_caches()` calls all of them - **if you add a cached factory,
add it there too.**

## Module map

| Module | Responsibility | Public surface |
|---|---|---|
| `logging_setup.py` | Structured logs (`text`/`json`) + heartbeat file | `get_logger`, `setup_logging`, `ContextLogger.bind`, `write_heartbeat`, `heartbeat_age_seconds`, `utc_now_iso` |
| `messaging.py` | Queue abstraction: `HandlerResult`/`Outcome`, `Delivery`, `DirectoryQueue`, `AmqpQueue`, retry ladder, DLQ | `get_queue`, `HandlerResult.ack/retry/retry_later/dead_letter`, `RETRY_LADDER_SECONDS` |
| `db.py` | Job store + claim semantics + schema DDL | `get_db`, `job_key`, `new_job_id`, `JOB_FIELDS`, `SCHEMA_SQL`, `ACTIVE_STATUSES` |
| `storage.py` | Local artifact IO + per-task materialisation | `get_storage`, `TaskContext`, `LocalStorage`, `output_key_for` |
| `model_state.py` | Model-availability ledger + fallback ladder | `init_model_state`, `advance_after_failure`, `next_available_model`, `preferred_available` |
| `retry.py` | Gemini backoff + quota handling | `retry_with_exponential_backoff`, `RetryLater`, `wait_until_midnight_utc` |
| `docx_mutator.py` | DOCX AST/XML replacements + sync validation | `apply_text_replacements`, `normalize_replacements`, `validate_cv_data_against_docx`, `cv_data_to_text`, `extract_doc_text`, `load_cv_data` |
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
  `validate_cv_data_against_docx()` returns the lines it could not find (empty == in sync).
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
