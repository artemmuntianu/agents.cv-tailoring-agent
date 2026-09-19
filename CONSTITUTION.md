# Constitution

Canonical architecture, invariants and known discrepancies for **CVTailoringAgent**.

Read this **before** the per-layer `AGENTS.md` files. Its purpose is to stop every
new session from re-deriving the design, and to make the places where the code and
the prose disagree explicit instead of surprising.

> Owner: every agent that touches this repo. If you change a fact recorded here,
> update this file in the same change.

---

## 1. What this system is

Turns a job description into a CV tailored for it, as **DOCX + PDF**, using:

| Concern | Technology |
|---|---|
| Orchestration | LangGraph (`agent/graph.py`) |
| LLM (the only external call) | Google Gemini (`google-genai`) |
| Document surgery | `python-docx` (AST/XML mutation) |
| Rendering | LibreOffice (`soffice`) to poppler (`pdftoppm`) |
| Queue | RabbitMQ via `pika`, or JSON files |
| State | Postgres via `psycopg`, or a JSON file |
| Artifacts | A local directory / PersistentVolumeClaim (temp work under an `emptyDir`) |

Everything runs **on one machine, in a local Kubernetes cluster**. There is no
cloud account, no object storage and no managed database. The only outbound call
is to the Gemini API.

```
publisher / Chrome extension --> RabbitMQ (rabbitmq-0, resumes.generate)
                                     |  KEDA: queue depth -> replicas (0 -> M -> 0)
                                     v
                     ai-agent-worker pod (prefetch = 1, one vacancy per message)
                     adapt_text -> render -> vision_check -> persist
                                     |
                  cv-artifacts volume (PDF/DOCX) + Postgres (status)
```

## 2. Three ways to run the same pipeline

`agent/pipeline.py` is the **single** implementation of the flow; every entry
point delegates to it.

| Mode | Entry point | Queue / DB / Storage |
|---|---|---|
| Local cluster (primary) | `.\scripts\local-deploy.ps1`, then `worker.py` in a pod | amqp / postgres / PVC `/data` |
| Batch CLI | `python main.py` | directory / local / `artifacts/` |
| docker compose | `docker compose up -d rabbitmq postgres` + worker | amqp / postgres / bind-mounted `artifacts/` |

Backends are selected purely by env vars (`QUEUE_BACKEND`, `DB_BACKEND`,
`MODEL_STATE_BACKEND`). Storage has **no** backend switch - it is always local
(see section 5, discrepancy D1).

## 3. Layer map and dependency direction

```
entry points        main.py · worker.py · publisher.py · healthcheck.py
      |                     |
      v                     v
orchestration      agent/   (state, contracts, models, nodes, graph, pipeline)
      |
      v
adapters/infra     utils/   (messaging, db, storage, model_state, retry,
      |                      docx_mutator, renderer, logging_setup)
      v
config             config.py   (env parsing only; imports no provider SDK)

deployment         charts/ · deploy/values/ · Dockerfile · docker-compose.yml
operator tooling   scripts/ · Makefile
verification       tests/
documentation      docs/ · README.md
automation         .github/workflows/
```

**Direction invariant:** `agent/` may import `utils/` and `config`; `utils/` must
**never** import `agent/`. `config.py` imports nothing from this project.

## 4. Invariants (do not break these silently)

1. **One pipeline.** `agent/pipeline.run_cv_tailoring()` / `run_task()` are the
   only ways to run the graph; `main.py` and `worker.py` both call them.
2. **Ack only after `persist`.** The queue message is acknowledged after the
   artifact is stored *and* the DB row is written, so a crash/OOM/scale-down
   simply redelivers the message (`worker.handle_delivery`, `agent/nodes.persist`).
3. **Idempotency.** Business key `coalesce(user_id,'local') : external_id :
   cv_version`, enforced by the unique index `resumes_job_key_idx`. A duplicate
   delivery must never pay for Gemini twice.
4. **`job_id` is an opaque row id, not a business key.** Shape guard
   `[A-Za-z0-9_.:-]{4,80}` (anchored; Pydantic field plus the
   `resumes_job_id_shape` CHECK). A `job_id` that already belongs to another
   vacancy is refused (`outcome=owned`).
5. **The sync rule.** Every line of `cv_data.json` must exist **verbatim** in the
   master `cv.docx`; `validate_cv_data_against_docx()` enforces it and the task
   fails rather than mutating the wrong paragraph.
6. **Replacements are single-line and marker-free.** `normalize_replacements()`
   splits concatenated label+value pairs, drops misaligned lines and no-ops, and
   strips leading bullet characters; `apply_text_replacements()` additionally
   skips any `original_text` containing a newline.
7. **No fabrication (hard rule).** The adaptation prompt may rephrase and
   re-weight only what is already on the CV - no invented employers, titles,
   dates, technologies or metrics.
8. **Fail fast on misconfiguration.** `worker.preflight()` checks storage, DB,
   render tools and `MODEL_NAME` (against `models.list()`) before consuming. A
   wrong model id is a non-retryable 400, so it must not reach a task.
9. **Headless means never-block.** Quota exhaustion raises `RetryLater` and the
   worker re-publishes to a TTL retry queue; only an interactive TTY may wait.
10. **Graceful shutdown.** SIGTERM sets `STOP_EVENT` and stops the consumer; the
    in-flight task finishes and is acked before the process exits.
11. **State is a flat, fully-populated TypedDict.** `initial_state()` fills every
    key so nodes may read without `KeyError`.
12. **Gemini calls are decorated.** Every `_call_gemini_*` goes through
    `retry_with_exponential_backoff` (429/503 backoff, model fallback ladder,
    daily-quota handling).
13. **Secrets never live in git.** `.env` is gitignored; charts use
    `existingSecret`; `scripts/worker-secret.ps1` creates the Secret.
14. **`helm lint`/`helm template` are not enough.** Render and validate with
    `kubeconform` before trusting a chart change (see section 5, D8).

## 5. Known discrepancies, dead code and legacy paths

These were verified against the working tree on 2026-09-19. They are **not**
invitations to "fix" blindly - they are recorded so nobody rediscovers them, and
so that a change which depends on them is a conscious one.

| # | What | Reality | Status |
|---|---|---|---|
| D1 | `Dockerfile` line 48 comment ("persist to Supabase") and line 51 `ENV STORAGE_BACKEND=supabase` | There is no `STORAGE_BACKEND` in `config.py`, and `utils/storage.py` has no backend selection - storage is unconditionally `LocalStorage`. `deploy/values/dev.yaml` (`config.storageBackend: local`) and `.github/workflows/helm-smoke.yml` (`--set config.storageBackend=local`) set a value that `charts/cv-tailoring-worker/templates/configmap.yaml` never renders, so both are inert as well | **Dead** (leftover from the removed Supabase era). Harmless at runtime, misleading to readers. |
| D2 | `pyproject.toml` description: "...LangGraph + RabbitMQ + Supabase" | Supabase was removed; storage is a PVC | **Stale metadata** |
| D3 | `requirements.txt`: `pypdf>=4.0.0` | Not imported anywhere in the repo | **Unused dependency** |
| D4 | `config.RABBITMQ_MANAGEMENT_URL` | Defined and passed by `docker-compose.yml`, but never read by application code - KEDA talks to the RabbitMQ management API itself | **Unused config** |
| D5 | `config.QUEUE_RETRY_TTL_MS` and chart key `config.queueRetryTtlMs` | `utils/messaging.py` uses the hard-coded `RETRY_LADDER_SECONDS = (60, 300, 900, 1800, 3600)`; the env var is never read, so the chart knob is **inert** | **Unused config** |
| D6 | `utils/renderer.convert_docx_to_pdf` fallback `from docx2pdf import convert` | `docx2pdf` is not in `requirements*.txt`; Windows-only, unexercised | **Untested fallback** |
| D7 | Test counts in the removed `docs/PROJECT_STATE.md` handoff ("41 tests", "35 pass, 6 skip") | Actual: **45 collected, 6 skipped, 39 passed** (`python -m pytest -q`, 2026-09-19); the 6 skips are the `TEST_DATABASE_URL`-gated Postgres tests | **Stale doc** |
| D8 | The removed `docs/PROJECT_STATE.md` claimed the image was never built and `helm install` never ran | It was a session handoff, not live status. CI does run `helm-smoke.yml` on chart changes, but do not assume a live cluster was ever exercised - re-check before relying on it | **Possibly stale** |
| D9 | `.env` may still contain Supabase keys | They are unused | **Cleanup candidate** |
| D10 | The previous `docs/` set (`ARCHITECTURE.md`, `MESSAGE_CONTRACT.md`, `PROJECT_STATE.md`, `RUNBOOK.md`, `postgres_schema.sql`) was deleted in `46a76fd`, but two call sites still point at it | `docker-compose.yml` mounts the deleted DDL as its initdb script, and `main.py` prints a hint naming the removed `MESSAGE_CONTRACT.md` (`README.md`, the root `AGENTS.md` and the layer files were repointed in the same change) | **Dangling references** - drop the compose mount or restore the DDL with `git show 46a76fd^:docs/postgres_schema.sql`; the `main.py` hint can point at `README.md` instead |

### Legacy / removed (do not reintroduce)

* **Supabase Storage** - replaced by the `cv-artifacts` PVC plus `utils.storage.LocalStorage`.
* **Azure / AKS / ACR / Bicep** and the cloud deploy workflow - deleted in favour of local-first.
* **Bitnami RabbitMQ subchart** - replaced by our own StatefulSet on the official
  `rabbitmq:3.13-management` image (the Bitnami index moved behind
  `repo.broadcom.com` and its free images were emptied; see
  `charts/cv-tailoring-platform/Chart.yaml`).

* **The previous `docs/` set** - `ARCHITECTURE.md`, `MESSAGE_CONTRACT.md`,
  `PROJECT_STATE.md`, `RUNBOOK.md`, `postgres_schema.sql` - deleted in `46a76fd`.
  Their topics are owned by the layer `AGENTS.md` files and by this document now,
  and the originals stay recoverable from history
  (`git show 46a76fd^:docs/<file>`).


## 6. Entry points (root files)

| File | Role | Notes |
|---|---|---|
| `config.py` | Every env-overridable setting | Import-safe without provider SDKs; calls `load_dotenv()` |
| `main.py` | Batch CLI over `artifacts/input/jd_*.txt` | Skips a JD whose `cv_{jd_id}.docx` already exists in the output dir |
| `worker.py` | Queue consumer (the pod) | preflight -> claim -> prepare -> graph -> ack/retry/DLQ |
| `publisher.py` | Dev stand-in for the Vercel gateway | Publishes the real payload shape; `--all`, `--jd`, `--payload` |
| `healthcheck.py` | Exec probes | `--mode liveness`, `readiness`, `amqp`, `render`, `all` |
| `model_state.json` | Local model-availability ledger | **Tracked but rewritten at runtime** - restore with `git checkout -- model_state.json` after local runs |

## 7. Verification expectations

```sh
python -m pytest -q          # hermetic: no network, no Gemini, no LibreOffice
python -m ruff check .       # must stay clean (line-length 100, target py311)
```

`tests/test_postgres_store.py` only runs when `TEST_DATABASE_URL` points at a
throwaway Postgres (`make test-postgres`); otherwise those 6 tests skip. A change
that touches the DB, queue, DOCX mutator or retry logic is not done until the
suite passes.

## 8. When code and prose disagree

The **code wins**, and the disagreement belongs in section 5 of this file in the
same change. Documentation that is allowed to drift silently is worse than no
documentation.

