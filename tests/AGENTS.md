# tests/ - the hermetic verification layer

Proves the pipeline works **without a network, without Gemini and without
LibreOffice**: every LLM call and both render tools are mocked and every
path/backend points at a `tempfile.TemporaryDirectory()`. The only exception is
the Postgres file, which is skipped unless it is explicitly pointed at a
throwaway database.

Read `CONSTITUTION.md` first (section 7 is the verification contract).

## Files

| File | Owns |
|---|---|
| `conftest.py` | Puts the repo root on `sys.path` so pytest runs from any cwd |
| `helpers.py` | Fixture-free harness: `isolated_config`, `fake_gemini`, `reset_caches`, sample CV/JD builders |
| `test_candidate_facts.py` | The candidate-facts block: one renderer for the facts + standing answers, the two caps (`MAX_VALUE_CHARS` / `MAX_ANSWER_CHARS`), both stored shapes, and a missing row/user as an empty block rather than an error |
| `test_contracts.py` | `ResumeTaskMessage` defaults, the `job_id` shape guard, `key()`, `to_job_row()`, `new_job_id()` |
| `test_cover_letter.py` | The letter prompt (only what the CV and the candidate facts state), the digest (projects deliberately excluded), and `cover.handle_delivery`: written / duplicate / quota-deferred / dead-lettered, plus the two queues never sharing storage |
| `test_cv_replacements.py` | The rules a replacement must satisfy: concatenated label+value splitting, misaligned/duplicate/no-op dropping, and the read-only projects block |
| `test_cv_text.py` | The CV model as text: every section rendered (projects included), and the legacy path-string call |
| `test_db_claim.py` | Claim outcomes `claimed` / `duplicate` / `owned` and the re-claim of a failed row (local backend) |
| `test_docx_mutator.py` | The AST surgery that must never regress: the paragraph rewritten and the master left untouched, and the sync validator detecting drift |
| `test_heartbeat.py` | The idle heartbeat thread: it refreshes the readiness file with no messages in flight, and it is a daemon that a `STOP_EVENT` ends |
| `test_messaging.py` | Directory-queue semantics: ack -> `processed`, retry (attempt bump), dead-letter -> `failed`, a crashing handler requeues |
| `test_model_state.py` | Model ledger: preference order, unavailability TTL, exhaustion -> `None` |
| `test_scout.py` | The scheduled intake: the feed fixture (escaped HTML, double-escaped entities, the utm link, the apply tail), the title/id parsing, the board-scoped dedupe, "a run queues nothing", the Telegram message, that a run without a feed is an *error*, and the ledger row a run records |
| `test_postgres_store.py` | **Real** Postgres: schema bootstrap from an empty database (all 13 tables, in dependency order), the shape CHECK, `resume_board`'s detail CHECK including the http(s)-only `apply_url` and its guard-first widening, claim SQL, the shared ledger. Skipped unless `TEST_DATABASE_URL` is set |
| `test_process_runs.py` | The run ledger: a run is always closed (a `return` inside the block, a crash -> `failed` and the error propagates), `--dry-run` records nothing, a store that refuses to open a row is not fatal, and the next run retires a killed one as `aborted` |
| `test_archiver.py` | The inactivity sweep, hermetically with an injected `FakeBoard`: which columns/window/actor/reason reach the query, a partial sweep's exit code, `--dry-run` writes nothing, the JSON backend refuses to run, and a typo in the config fails the run loudly |
| `test_retry.py` | `_is_retryable`, daily-quota detection, headless `RetryLater`, backoff |
| `test_worker_pipeline.py` | End-to-end `worker.handle_delivery` / `worker.main --once`: happy path, duplicate, DLQ, master-CV drift, quota deferral, attempt ceiling |

Expected result where `TEST_DATABASE_URL` is unset (2026-09-29): **152 collected, 124 passed,
28 skipped**, and the backoffice suite is **250 passed / 24 files** (`npm test`). The superseded
counts (150/122/28 and 250/24, 2026-09-29; 132/104/28 and 213/21, 2026-09-29; 109/82/27 and
156/15, 2026-09-27; 45/39/6, 2026-09-19) are history.

## Commands

```sh
python -m pytest -q            # the default gate; must stay green
python -m ruff check .         # lint covers tests/ too (B011 is ignored here)
make test-postgres             # or:
TEST_DATABASE_URL=postgresql://cvt:cvt@localhost:5432/cvt python -m pytest -q tests/test_postgres_store.py
```

The 28 Postgres-gated tests need a database: point them at the cluster's own Postgres
through a port-forward (`kubectl port-forward svc/postgres 5432:5432`), or let CI
provide one as a service container (`.github/AGENTS.md`). **Use a throwaway database, never the
one the worker owns** - the `store` fixture *drops* its tables. They cover the worker's claim
semantics (including the ingest row the gateway pre-creates), the board's tables
(`resume_board` with its archive columns and the operator's own detail fields, `resume_history`
with the `Candidate`/`Company` actor vocabulary and the four kinds), the backoffice's
`app_users`, the Action catalogue's admin writes and its catalogue-only read (`board_actions`)
and the removal purge (`artifact_purge` + the cascade).

## The harness contract (`helpers.py`)

- `isolated_config(tmp_dir, cv_data=None)` `setattr`s `config.ARTIFACTS_DIR`,
  `INPUT_DIR`, `OUTPUT_DIR`, `QUEUE_DIR`, `TEMP_ROOT`, `CV_DATA_PATH`,
  `MODEL_STATE_FILE`, plus `QUEUE_BACKEND=directory`, `DB_BACKEND=local`,
  `MODEL_STATE_BACKEND=file`, then calls `reset_caches()`. It writes a faithful
  `cv.docx` + `cv_data.json` pair and restores every attribute in `finally`.
  **Use it (or `tempfile.TemporaryDirectory()`) in anything that touches
  `config`** - otherwise a run rewrites the tracked `model_state.json` and drops
  files under `artifacts/`.
- `fake_gemini(replacements, layout_ok=True, calls=None, prompts=None)` patches the one definition
  site of every model-facing helper - `agent.gemini.client`, `extract_role`, `suggest_replacements`
  and `evaluate_layout` - so the tailoring nodes, the letter and the form prompt are all covered by
  the same patch - plus `convert_docx_to_pdf` / `convert_pdf_to_images` on `agent.nodes`, which is
  where `render` calls them. Pass a dict as `calls` to count LLM invocations -
  that is how "a duplicate never pays for Gemini twice" is asserted - and a list as
  `prompts` to capture the tailoring prompt, which is how "the candidate facts and the
  read-only projects block reached the model" is asserted.
- `reset_caches()` calls `db.reset_db_cache()`, `storage.reset_storage_cache()`,
  `messaging.reset_queue_cache()` and `model_state.reset_store_cache()`.
  **A new cached `get_*()` factory in `utils/` must be added here too** (see
  `utils/AGENTS.md`).
- Builders: `sample_task(...)`, `SAMPLE_CV_DATA`, `SAMPLE_CANDIDATE`, `SAMPLE_JD`,
  `docx_lines`, `write_docx`, `write_master_cv`, `seed_candidate`, `list_dir`. Keep
  helpers fixture-free so they also work from a plain script. `seed_candidate(user_id)`
  writes the candidate-facts row the three prompts read (Redis is the technology the
  sample CV deliberately omits, which the verification tests lean on).

## Rules

1. A test that needs Postgres must be gated by
   `pytest.mark.skipif(not os.getenv("TEST_DATABASE_URL"))`, must drop the tables
   it uses in a fixture (before *and* after) and must never run against a
   database it does not own. The `store` fixture must list **every** table `SCHEMA_SQL` creates:
   a missing one either fails the teardown (`DependentObjectsStillExist`) or - worse - leaves a
   table standing and hides a create-order bug, which is how `application_profile` referencing a
   not-yet-created `app_users` survived on a fresh database (`CONSTITUTION.md` D14).
2. A test that touches the graph goes through `fake_gemini`; never call the real
   API, never shell out to LibreOffice or poppler. The same rule has a second
   half that CI enforces: **the suite must pass with no `GEMINI_API_KEY` in the
   environment**. `run_cover_letter` builds its client *before* the model call, so
   patching `_call_gemini_cover_letter` alone is not enough - patch
   `agent.gemini.client` too (`test_cover_letter.py::fake_client`). Four
   tests that were green on a developer machine (a key in `.env`) dead-lettered
   on every CI run until 2026-09-29.
3. Assert on outcomes (`Outcome.ACK` / `RETRY` / `RETRY_LATER` / `DEAD_LETTER`,
   `claimed` / `duplicate` / `owned`), not on log text.
4. Restore anything you patched on `config`; prefer `isolated_config`.
5. New behaviour means a new assertion here - CI runs this suite on every PR.

## Don't

- Add a network, Gemini, LibreOffice or broker dependency to the default suite.
- Leave `model_state.json` or `artifacts/` dirty after a local run
  (`git checkout -- model_state.json`).
- Weaken or delete a regression test to make a change pass; fix the code or
  record the discrepancy in `CONSTITUTION.md` section 5.
- Import `agent/` from a `utils/` module just to make a test easier.
