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

## 2. One way to run the pipeline

`agent/pipeline.py` is the **single** implementation of the flow, and there is a
single supported runtime: the **local Kubernetes cluster** installed by
`.\scripts\local-deploy.ps1` (Docker Desktop on the dev machine), where `worker.py`
consumes the RabbitMQ queue inside a pod. Queue = amqp, DB = postgres, model state =
postgres, artifacts = the `cv-artifacts` PVC at `/data`.

`QUEUE_BACKEND` / `DB_BACKEND` / `MODEL_STATE_BACKEND` still exist because the
hermetic test suite switches on them (`directory` / `local` / `file`); nothing in the
shipped deployment uses those values. Storage has **no** backend switch - it is
always local (section 5, D1).

## 3. Layer map and dependency direction

```
entry points        worker.py · publisher.py · healthcheck.py
      |                     |
      v                     v
orchestration      agent/   (state, contracts, models, nodes, graph, pipeline)
      |
      v
adapters/infra     utils/   (messaging, db, storage, model_state, retry,
      |                      docx_mutator, renderer, logging_setup)
      v
config             config.py   (env parsing only; imports no provider SDK)

deployment         charts/ · deploy/values/ · Dockerfile
operator tooling   scripts/ · Makefile
verification       tests/
documentation      docs/ · README.md
backoffice         backoffice/  (Astro+React kanban UI + the authenticated batch gateway;
                                 shares the worker's Postgres)
scraper            extension/   (Chrome MV3 scraper -> backoffice gateway -> queue)
automation         .github/workflows/
```

**Direction invariant:** `agent/` may import `utils/` and `config`; `utils/` must
**never** import `agent/`. `config.py` imports nothing from this project.

## 4. Invariants (do not break these silently)

1. **One pipeline.** `agent/pipeline.run_cv_tailoring()` / `run_task()` are the
   only ways to run the graph; `worker.py` calls them (and so do the tests).
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
15. **No public signup, ever.** Backoffice accounts exist only because an
    administrator provisioned them (`backoffice/scripts/user.mjs`); the UI
    authenticates and never creates. A session is an HS256 token (cookie for the
    browser, `Authorization: Bearer` for the extension) signed with
    `BACKOFFICE_JWT_SECRET`, and `backoffice/src/middleware.ts` is the only gate.
16. **The gateway publishes what the worker can consume.** `POST /api/vacancies/batch`
    validates the whole batch *before* the first publish (required `external_id` +
    `description_raw`, http(s) `source_url`, ≤25 cards) and emits exactly
    `ResumeTaskMessage`; the AMQP topology in `backoffice/src/lib/queue.ts` mirrors
    `utils/messaging.py` field for field (a mismatch is a 406 from the broker).
17. **A scraped vacancy is a card immediately, and the worker's claim adopts it.** The
    batch gateway inserts the `resumes` row (`status = 'submitted'`, `job_id` = the
    one it puts in the message) *before* publishing, and deletes the rows it created if
    the publish fails. `submitted` must stay out of `ACTIVE_STATUSES`, otherwise the
    claim would ack the message as a duplicate and the card would never run; being
    non-active makes `_claim_row` re-claim that exact row. The board's *move* path
    still never writes `resumes.status`.
18. **`resumes.pdf_url` / `docx_path` are storage paths, not URLs.** They are what
    `utils/storage.LocalStorage.upload` returned (`/data/output/848944.pdf` in the
    cluster), so nothing in a browser may link them: the board serves downloads from
    `GET /api/artifacts/<job_id>` (keyed by `job_id`, resolved against `ARTIFACTS_DIR`,
    traversal-refused) and reports "not on this machine" instead of a bare 404.
19. **Refusing a vacancy is an in-place soft delete.** `resume_board.archived_at` /
    `archived_actor` / `archived_reason` are set (or cleared) in one transaction with the
    `resume_history` row (`kind` `archive`/`restore`, `from_state`/`to_state`
    `active`/`archived`) and the `board_actions` upsert. `stage` is never touched - the
    card stays in the column where it stopped, only muted - and `resumes.status` stays the
    worker's alone. An archived vacancy counts as a *duplicate* for the ingest gateway:
    re-scraping a page never re-queues a card the operator has closed, whatever its
    tailoring status says. "Archived" is a state, never a column
    (`isStageId('archived')` is false, and the DB enforces the three columns together).
20. **The Actor vocabulary is `Candidate` | `Company`.** That is what the dialogs store
    (`resume_history.actor`, `resume_board.archived_actor`); rows written before
    2026-09-26 said `Me`/`Them` and were renamed in place by the guarded migration block in
    `SCHEMA_SQL`. The *Action* vocabulary is data, not code: `board_actions` (seeded with
    eleven starting values) is written by the same transaction as the change it describes
    and read by both the dialog comboboxes and the Filters panel - so the operator's own
    wording comes back as a suggestion and as a filter option.
21. **The vocabularies have one admin surface, and it is gated.** `GET/POST/PATCH/DELETE
    /api/admin/*` and the `/admin` page require `app_users.is_admin`, which is copied into
    the signed session token at login (`lib/auth.ts`; a token without the claim counts as
    false, so a stale cookie cannot grow privileges). The middleware is the gate - 403 for
    the API, the `/403` page for the browser - and the routes re-check the claim.
    **Only Actions are editable**: the Actor list is a DB CHECK, the columns are the board's
    shape (`isStageId`) and the tailoring sub-states are derived from the worker's statuses,
    so `/admin` renders those three from the code that defines them.
    **A vocabulary edit is catalogue-only** - `resume_history` and `archived_reason` keep
    the words they were recorded with, and a removed value stays filterable as
    `catalogued: false` (dialog comboboxes stop suggesting it; the Filters panel keeps
    offering it, because deleting a word must not make past cards unfindable).

## 5. Known discrepancies, dead code and legacy paths

These were verified against the working tree on 2026-09-19. They are **not**
invitations to "fix" blindly - they are recorded so nobody rediscovers them, and
so that a change which depends on them is a conscious one.

| # | What | Reality | Status |
|---|---|---|---|
| D1 | `Dockerfile` line 48 comment ("persist to Supabase") and line 51 `ENV STORAGE_BACKEND=supabase` | There is no `STORAGE_BACKEND` in `config.py`, and `utils/storage.py` has no backend selection - storage is unconditionally `LocalStorage`. `deploy/values/dev.yaml` (`config.storageBackend: local`) and `.github/workflows/helm-smoke.yml` (`--set config.storageBackend=local`) set a value that `charts/cv-tailoring-worker/templates/configmap.yaml` never renders, so both are inert as well | **Dead** (leftover from the removed Supabase era). Harmless at runtime, misleading to readers. |
| D2 | `pyproject.toml` description: "...LangGraph + RabbitMQ + Supabase" | Supabase was removed; storage is a PVC | **Fixed 2026-09-25** (description now names local Kubernetes) |
| D3 | `requirements.txt`: `pypdf>=4.0.0` | Not imported anywhere in the repo | **Unused dependency** |
| D4 | `config.RABBITMQ_MANAGEMENT_URL` | Defined in `config.py` (and formerly passed by the removed `docker-compose.yml`), but never read by application code - KEDA reaches the management API through the broker Secret's `rabbitmq-management-url` key instead | **Unused config** |
| D5 | `config.QUEUE_RETRY_TTL_MS` and chart key `config.queueRetryTtlMs` | `utils/messaging.py` uses the hard-coded `RETRY_LADDER_SECONDS = (60, 300, 900, 1800, 3600)`; the env var is never read, so the chart knob is **inert** | **Unused config** |
| D6 | `utils/renderer.convert_docx_to_pdf` fallback `from docx2pdf import convert` | `docx2pdf` is not in `requirements*.txt`; Windows-only, unexercised | **Untested fallback** |
| D7 | Test counts in `docs/PROJECT_STATE.md` ("41 tests", "35 pass, 6 skip") | Actual: **56 collected, 17 skipped, 39 passed** (`python -m pytest -q`, 2026-09-26); the 17 skips are the `TEST_DATABASE_URL`-gated Postgres tests | **Stale doc** |
| D8 | `docs/PROJECT_STATE.md` claims the image was never built and `helm install` never ran | It is a session handoff, not live status. CI does run `helm-smoke.yml` on chart changes, but do not assume a live cluster was ever exercised - re-check before relying on it | **Possibly stale** |
| D9 | `.env` may still contain Supabase keys | They are unused | **Cleanup candidate** |
| D10 | `docs/postgres_schema.sql` vs `utils/db.SCHEMA_SQL` | **Resolved 2026-09-25**: the `.sql` file existed only for the removed docker-compose initdb path; it is deleted, so `utils/db.SCHEMA_SQL` - what the worker executes on startup, and therefore what exists in the cluster - is the single source of truth. The extra objects it created (`vacancies`, `applications`, `resumes_status_idx`, `resumes_created_at_idx`, `set_updated_at()`) were never used by the runtime | **Resolved - one source of truth** |
| D11 | `backoffice/` (the kanban POC) | Shares the worker's Postgres: it reads `resumes` and owns `resume_board` + `resume_history` + `app_users` (all in `SCHEMA_SQL`, the vacancy-linked ones `on delete cascade`), one transaction per manual move (`actor` + reason recorded). It never writes `resumes.status` - the `created` sub-state is derived from it. Authentication: admin-provisioned accounts, HS256 session cookie or bearer token, no signup route. Its batch gateway *creates* the card (`resumes` row, `status='submitted'`) before publishing, so a scraped vacancy is on the board at once (invariant 17), and its artifact links are served by the board (`GET /api/artifacts/<job_id>`) because the stored values are paths on the `cv-artifacts` volume (invariant 18). Refusals are an in-place soft delete with an audited reason (invariant 19) and the Action vocabulary lives in `board_actions` (invariant 20); the top bar's Filters panel is where archived cards, columns and actions are selected. **Roles are enforced for the vocabulary admin surface only** (`/admin` + `/api/admin/*` need the `is_admin` claim, invariant 21) - the board itself is still all-users, and the remaining `app_users` management is the CLI | **POC gap** - still not deployed in-cluster; run it locally against `kubectl port-forward svc/postgres 5432:5432` (and `svc/rabbitmq 5672:5672` for the batch endpoint) |
| D12 | The source design's Supabase + Vercel hop | Both providers are out (`Supabase` = legacy, `Vercel` = never part of the local runtime), so their *functions* were implemented locally instead: **auth** = `app_users` + `backoffice/src/lib/auth.ts` + `scripts/user.mjs` (manual provisioning, no signup); **storage** = the `cv-artifacts` PVC (`utils/storage.py`); **API gateway** = `POST /api/vacancies/batch`; **realtime push** = the board's 5s live poll (`App.tsx`), not WebSockets. `applications.submit` has no producer yet and `vacancies.parse` has no consumer (parsing is client-side in `extension/`) | **Substituted by design** - do not reintroduce the providers; `extension/` is the real replacement for the design's "Chrome extension" box |

### Legacy / removed (do not reintroduce)

* **Supabase Storage** - replaced by the `cv-artifacts` PVC plus `utils.storage.LocalStorage`.
* **Azure / AKS / ACR / Bicep** and the cloud deploy workflow - deleted in favour of local-first.
* **Bitnami RabbitMQ subchart** - replaced by our own StatefulSet on the official
  `rabbitmq:3.13-management` image (the Bitnami index moved behind
  `repo.broadcom.com` and its free images were emptied; see
  `charts/cv-tailoring-platform/Chart.yaml`).
* **Every second way to run the app** - removed 2026-09-25 in favour of the single
  local-cluster runtime: the batch CLI (`main.py`), `docker-compose.yml`, the
  managed-cluster documentation and `docs/postgres_schema.sql` (D10). Publishing from
  the host is `scripts/send-test-job.ps1` → `publisher.py`; the batch *CLI* entry point
  is gone for good - do not add another one. (The HTTP batch endpoint in the backoffice
  is a different thing: it is a gateway, not a second runtime - see D12.)
* **Supabase (Auth, DB, Storage, Realtime) and Vercel.** Their *functions* now live in
  the local stack - admin-provisioned accounts in `app_users` (`backoffice/src/lib/auth.ts`),
  the gateway as `POST /api/vacancies/batch`, storage on the `cv-artifacts` PVC, and a
  poll-based live board instead of realtime WebSockets (D12). Do not reintroduce either
  provider, and do not add a signup form.
* **kind / k3d / minikube support** in `scripts/local-deploy.ps1`. Docker Desktop's
  kubeadm cluster shares Docker's image store, which is what makes a locally built
  image visible to the kubelet; every other local provider keeps its own store and
  would need an explicit image load.

* **The classic `docs/` set was deleted once, then restored.** `46a76fd` removed
  `ARCHITECTURE.md`, `MESSAGE_CONTRACT.md`, `PROJECT_STATE.md`, `RUNBOOK.md` and
  `postgres_schema.sql`; they came back in `4678752` and the commit that follows it. They are
  current documentation again - the layer `AGENTS.md` files own the mechanics and these
  documents own the deep dives. Do not delete them again without moving their content.
  (`postgres_schema.sql` is the one exception: it was deleted again on 2026-09-25, this
  time deliberately, because its only consumer - the docker-compose initdb path - was
  removed and `utils/db.SCHEMA_SQL` is the only schema; see D10.)


## 6. Entry points (root files)

| File | Role | Notes |
|---|---|---|
| `config.py` | Every env-overridable setting | Import-safe without provider SDKs; calls `load_dotenv()` |
| `worker.py` | Queue consumer (the pod) | preflight -> claim -> prepare -> graph -> ack/retry/DLQ |
| `publisher.py` | Host-side dev stand-in for the API gateway | Publishes the real payload shape; `--all`, `--jd`, `--payload`. Driven by `scripts/send-test-job.ps1`. The in-app gateway (scraped batch → one message per vacancy) is `backoffice/src/pages/api/vacancies/batch.ts` |
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

The `backoffice/` layer has its own hermetic gates - run them for any change there:

```sh
cd backoffice
npm test             # vitest: auth, board helpers, batch validation, scraper (jsdom)
npx tsc --noEmit     # types (no mypy equivalent on this side)
npm run build        # SSR bundle must build
```

## 9. What the first live deploy established (2026-09-25)

Facts only a real install could reveal. All were fixed in the same change - keep them true.

1. **KEDA ships its CRDs as templates**, and Helm builds every object of a release
   before creating any of them, so a `ScaledObject` in the same release as its CRD
   cannot be mapped. `local-deploy.ps1` therefore deploys in **two phases** on the
   first run (worker disabled, then the full release); later deploys are single-step.
   CI never sees this: `helm-smoke.yml` installs with `keda.enabled=false`.
2. **The broker refuses to seed a default vhost/user when `load_definitions` is set**
   ("Will not seed default virtual host and user: have definitions to load..."), so
   the definitions file must declare the vhost, the user and its permissions itself.
   `templates/definitions.yaml` fills them from the same values as
   `rabbitmq-credentials`. Without it the broker dies with
   `BOOT FAILED: Please create virtual host "/" prior to importing definitions.`
3. **`conf.d` must be mounted as a single file**, never over the directory: the image
   ships `conf.d/10-defaults.conf` (`log.console = true`) and its entrypoint writes
   the generated default-user settings into that directory. A directory mount
   silences the console log (the boot failure becomes invisible) and blocks the write.
4. **Pre-declared queue arguments must equal `utils/messaging.py`'s declaration**
   (`x-dead-letter-exchange` + `x-dead-letter-routing-key`), otherwise the first
   publish dies with `406 PRECONDITION_FAILED - inequivalent arg`.
5. **KEDA must scale over `protocol: http`** with the management URL from the Secret
   (`rabbitmq-management-url`). The AMQP count (`queue.declare-ok`) is ready-only, so
   a prefetched job looks like an empty queue and KEDA scales the worker to zero
   mid-task.
6. **The AMQP heartbeat must exceed the longest task** (`AMQP_HEARTBEAT_SECONDS`,
   default 600). pika cannot service heartbeats while the graph runs, so the old 60s
   heartbeat let the broker drop the connection mid-task and requeue the message -
   the task then restarted from scratch, indefinitely.
7. **The worker writes a periodic heartbeat while idle**
   (`worker.start_heartbeat_thread`), so readiness no longer fails after five idle
   minutes (which also made `helm upgrade --wait` time out).
8. **`helm uninstall` can leave KEDA CRDs behind** - delete them before re-installing.
9. **One Gemini model = 20 requests/day on the free tier.** A single CV can consume a
   whole model's budget (3 revisions + vision checks per page), so the
   `PREFERRED_MODELS` ladder (each model has its own quota) is the real fallback, and
   a long `adapt_text`/`vision_check` node is usually quota backoff, not a hang.
10. **The `cv-files` helper owns `/data/input` and `/data/output` as `10001:10001`**
    (`fileManager.owner`). The worker runs unprivileged (`runAsUser: 10001`), so
    root-owned directories made the first task die at `persist` with
    `[Errno 13] Permission denied: '/data/output/<name>.pdf'`.
11. **The `helm test` pod needs the same broker env as the Deployment**
    (`RABBITMQ_HOST/PORT/VHOST` + the credentials from the broker Secret): those are
    injected in the Deployment only, so the probe used to compose `guest@localhost:5672`
    and always failed.

---

## 8. When code and prose disagree

The **code wins**, and the disagreement belongs in section 5 of this file in the
same change. Documentation that is allowed to drift silently is worse than no
documentation.

