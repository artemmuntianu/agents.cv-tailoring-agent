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
| `test_contracts.py` | `ResumeTaskMessage` defaults, the `job_id` shape guard, `key()`, `to_job_row()`, `new_job_id()` |
| `test_db_claim.py` | Claim outcomes `claimed` / `duplicate` / `owned` and the re-claim of a failed row (local backend) |
| `test_docx_mutator.py` | The document surgery that must never regress: normalisation, bullet/no-op dropping, sync validation, master left untouched |
| `test_messaging.py` | Directory-queue semantics: ack -> `processed`, retry (attempt bump), dead-letter -> `failed`, a crashing handler requeues |
| `test_model_state.py` | Model ledger: preference order, unavailability TTL, exhaustion -> `None` |
| `test_postgres_store.py` | **Real** Postgres: schema bootstrap, the shape CHECK, claim SQL, the shared ledger. Skipped unless `TEST_DATABASE_URL` is set |
| `test_retry.py` | `_is_retryable`, daily-quota detection, headless `RetryLater`, backoff |
| `test_worker_pipeline.py` | End-to-end `worker.handle_delivery` / `worker.main --once`: happy path, duplicate, DLQ, master-CV drift, quota deferral, attempt ceiling |

Expected result where `TEST_DATABASE_URL` is unset:
**45 collected, 39 passed, 6 skipped** (`python -m pytest -q`, 2026-09-19).

## Commands

```sh
python -m pytest -q            # the default gate; must stay green
python -m ruff check .         # lint covers tests/ too (B011 is ignored here)
make test-postgres             # or:
TEST_DATABASE_URL=postgresql://cvt:cvt@localhost:5432/cvt python -m pytest -q tests/test_postgres_store.py
```

The 9 Postgres-gated tests need a database: point them at the cluster's own Postgres
through a port-forward (`kubectl port-forward svc/postgres 5432:5432`), or let CI
provide one as a service container (`.github/AGENTS.md`). They cover the worker's claim
semantics, the board's two tables (`resume_board`, `resume_history`) and the backoffice's
`app_users`.

## The harness contract (`helpers.py`)

- `isolated_config(tmp_dir, cv_data=None)` `setattr`s `config.ARTIFACTS_DIR`,
  `INPUT_DIR`, `OUTPUT_DIR`, `QUEUE_DIR`, `TEMP_ROOT`, `CV_DATA_PATH`,
  `MODEL_STATE_FILE`, plus `QUEUE_BACKEND=directory`, `DB_BACKEND=local`,
  `MODEL_STATE_BACKEND=file`, then calls `reset_caches()`. It writes a faithful
  `cv.docx` + `cv_data.json` pair and restores every attribute in `finally`.
  **Use it (or `tempfile.TemporaryDirectory()`) in anything that touches
  `config`** - otherwise a run rewrites the tracked `model_state.json` and drops
  files under `artifacts/`.
- `fake_gemini(replacements, layout_ok=True, calls=None)` patches
  `_call_gemini_extract_role`, `_call_gemini_text_adaptation`,
  `_call_gemini_vision_eval`, `get_genai_client`, `convert_docx_to_pdf` and
  `convert_pdf_to_images`. Pass a dict as `calls` to count LLM invocations -
  that is how "a duplicate never pays for Gemini twice" is asserted.
- `reset_caches()` calls `db.reset_db_cache()`, `storage.reset_storage_cache()`,
  `messaging.reset_queue_cache()` and `model_state.reset_store_cache()`.
  **A new cached `get_*()` factory in `utils/` must be added here too** (see
  `utils/AGENTS.md`).
- Builders: `sample_task(...)`, `SAMPLE_CV_DATA`, `SAMPLE_JD`, `docx_lines`,
  `write_docx`, `write_master_cv`, `list_dir`. Keep helpers fixture-free so they
  also work from a plain script.

## Rules

1. A test that needs Postgres must be gated by
   `pytest.mark.skipif(not os.getenv("TEST_DATABASE_URL"))`, must drop the tables
   it uses in a fixture (before *and* after) and must never run against a
   database it does not own.
2. A test that touches the graph goes through `fake_gemini`; never call the real
   API, never shell out to LibreOffice or poppler.
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
