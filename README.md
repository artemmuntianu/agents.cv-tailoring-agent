# CV Tailoring Agent

**An event-driven worker that turns a job description into a CV tailored for that
job, delivered as DOCX + PDF.**

Everything runs on your own machine, inside a local Kubernetes cluster: the
message queue, the autoscaler, the database and the file storage. The only
external call is the Gemini API.

![Python 3.11+](https://img.shields.io/badge/Python-3.11%2B-3776AB?logo=python&logoColor=white)
![Orchestration: LangGraph](https://img.shields.io/badge/orchestration-LangGraph-2F6F6F)
![LLM: Google Gemini](https://img.shields.io/badge/LLM-Google%20Gemini-4285F4?logo=google&logoColor=white)
![Deploy: Kubernetes](https://img.shields.io/badge/deploy-Kubernetes-326CE5?logo=kubernetes&logoColor=white)
![Packaging: Helm](https://img.shields.io/badge/packaging-Helm-0F1689?logo=helm&logoColor=white)
![CI](https://img.shields.io/badge/CI-ruff%20%2B%20pytest%20%2B%20helm-2088FF?logo=githubactions&logoColor=white)

## Contents

- [What it does](#what-it-does)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Key engineering decisions](#key-engineering-decisions)
- [Quickstart: the whole platform on your PC](#quickstart-the-whole-platform-on-your-pc)
- [Run without a cluster](#run-without-a-cluster)
- [Your files](#your-files)
- [Configuration](#configuration)
- [Tests and lint](#tests-and-lint)
- [Project layout](#project-layout)
- [Deployment](#deployment)
- [Documentation map](#documentation-map)
- [Optional: managed clusters](#optional-managed-clusters)

## What it does

Given a master CV (`cv.docx` plus the matching `cv_data.json`) and a job
description, the worker:

1. verifies that the structured CV data still matches the Word file (see [Your files](#your-files)),
2. extracts the target role from the vacancy and asks Gemini for line-by-line text replacements,
3. applies those replacements to the DOCX at the XML level with `python-docx`,
4. renders DOCX to PDF (LibreOffice) and PDF to page images (poppler),
5. sends the page images back to Gemini, which approves the layout or explains what is wrong,
6. repeats steps 2-5 while the layout is rejected, up to `MAX_REVISIONS`,
7. saves the PDF and the DOCX and writes the final status row,
8. and only then confirms the queue message.

The output is a tailored CV in Word and PDF plus a status row in Postgres, so a UI
can show progress and hand over the files.

## Architecture

```
extension (Chrome MV3) --batch--> backoffice gateway --+--> RabbitMQ (rabbitmq-0, resumes.generate)
publisher.py / send-test-job.ps1 ----------------------+        |  KEDA: queue depth -> replicas (0 -> M -> 0)
                                                              v
                                              ai-agent-worker pod (prefetch = 1, one vacancy per message)
                                              adapt_text -> render -> vision_check -> persist
                                                              |
                                          cv-artifacts volume (PDF/DOCX) + Postgres (status)
                                                              |
                                          backoffice board (same Postgres, live poll)
```

The graph inside the pod, with its two branch points:

```
adapt_text --(applied > 0)--> render --> vision_check --(approved)--> persist --> END
    |                                        |
    +--(applied == 0)--> persist             +--> adapt_text   (revise with layout feedback)
```

`check_after_adapt` short-circuits to `persist` when nothing matched in the
document; `should_continue` loops back to `adapt_text` with the reviewer feedback
until the layout is approved or `MAX_REVISIONS` is reached.

## Tech stack

| Concern | Technology |
|---|---|
| Orchestration | LangGraph (`agent/graph.py`) |
| LLM (the only external call) | Google Gemini via `google-genai` |
| Document surgery | `python-docx` (AST / XML mutation) |
| Rendering | LibreOffice `soffice` + poppler `pdftoppm` |
| Queue | RabbitMQ via `pika`, or a directory of JSON files |
| State | Postgres via `psycopg`, or a local JSON file |
| Artifacts | a local directory (`/data`, a PVC, in the cluster) |
| Deployment | Docker, Helm, KEDA, Kubernetes |
| Quality gates | pytest (hermetic), ruff, GitHub Actions |

## Key engineering decisions

### One pipeline, one runtime

`agent/pipeline.py` is the single implementation of the flow. The supported runtime
is the local Kubernetes cluster that `.\scripts\local-deploy.ps1` installs; the
queue/database backends stay environment-selectable for the hermetic tests, but this
repo ships no second run mode, so there is no parallel implementation to drift.

### Confirm the message only after the result is saved

`persist` is the mandatory terminal node, and the message is acknowledged only
after it returns. Each task carries the business key `(user_id, external_id,
cv_version)`, so a redelivered message claims the same row instead of starting a
duplicate run. Failed attempts are retried with exponential backoff and finally
parked in a dead-letter queue rather than retried forever. `job_id` is an opaque
row id, not a business key.

### Scale to zero on queue depth

`prefetch = 1` plus KEDA's `QueueLength` trigger (`ready + unacked`) means one pod
per waiting vacancy and no pod when the queue is empty. Counting in-flight work is
the important part: the deployment cannot scale to zero while a task is still
being processed.

### Fail loudly at the edges, never silently mid-task

The model id is validated against the provider's model list at start-up, because a
wrong id is a non-retryable error that would otherwise burn every attempt and send
every task to the dead-letter queue. The structured CV data is checked against the
Word file before any edit is allowed. Inside a task, status writes are
deliberately non-fatal: a database hiccup must not kill work that is progressing.

### Make the rendered PDF match what Word would show

PDF conversion is the CPU spike of the pipeline, so the image installs
metric-compatible fonts (Carlito and Caladea for Calibri and Cambria, Liberation
for Arial and Times) and pre-warms the LibreOffice user profile at build time.
Without them LibreOffice substitutes fonts silently, and the layout the reviewer
sees is not the layout Word would produce.

### Keep infrastructure swappable and the dependency direction one-way

Provider-specific code sits behind an environment-selected backend and a `get_*()`
factory with a matching `reset_*_cache()` test hook, so call sites never branch on
the backend. Dependencies run one way (`agent/` -> `utils/` -> `config`),
configuration is read once in `config.py`, and Gemini-specific code is confined to
`agent/nodes.py`.

### Tests that need no network, no LLM and no LibreOffice

The suite replaces all three Gemini calls and both render tools with fakes, so it
runs offline in CI. The production-store tests additionally run against a real
Postgres (a service container in CI, or the cluster's own database through
`kubectl port-forward svc/postgres 5432` - see `make test-postgres`).

### No secrets in the chart

Committed values files carry no credentials: the worker reads an `existingSecret`,
the broker password comes from a Secret shared with KEDA's trigger authentication,
and the helper scripts read `.env` locally without ever staging it.

## Quickstart: the whole platform on your PC

Prerequisites, once:

1. **Docker Desktop** -> *Settings -> Kubernetes -> Enable Kubernetes* (give Docker about 6 GB of RAM).
2. `winget install Helm.Helm`, then open a **new** terminal.

```powershell
.\scripts\local-deploy.ps1
```

That builds the worker image, creates the Secret from `.env`, and installs
RabbitMQ, KEDA, Postgres, the artifact volume and the worker (0 replicas until
there is work).

Then put your CV on the cluster volume and send a vacancy:

```powershell
.\scripts\storage-files.ps1 -Action seed        # push cv.docx + cv_data.json (+ any jd_*.txt)

.\scripts\send-test-job.ps1 -Smoke              # one vacancy; opens its own port-forward

kubectl get pods -w                              # 0 -> 1 -> 0
.\scripts\storage-files.ps1 -Action download    # tailored PDFs into artifacts\output
```

`send-test-job.ps1` exists because the manual version is wrong twice over:
`publisher.py` does not switch the queue backend on its own (the bare default is the
file-based `directory` backend the tests use) and the `rabbitmq-url` in the broker
Secret names the in-cluster DNS, which your machine cannot resolve. The script sets
`QUEUE_BACKEND=amqp`, rebuilds the URL against `localhost:<port>` through a
port-forward, and checks the release and the master CV on the volume before spending
any Gemini quota.

Teardown: `.\scripts\local-deploy.ps1 -Uninstall` (add
`kubectl delete pvc cv-artifacts` to drop the data as well).

## Backoffice (POC): the vacancy board and the batch gateway

A kanban UI for the pipeline - the cards *are* the worker's `resumes` rows, moved by
hand between **Created** (its sub-state follows the worker's status), **Applied**,
**Negotiating**, **Interviewing** and **Offer**. Every move asks for an actor
(Me/Them) and a reason, and both are written to `resume_history` in the same Postgres
the worker uses (`backoffice/AGENTS.md` documents the contract). The board re-reads the
database every few seconds (the `● Live` toggle), so worker progress shows up on its
own.

It is also the gateway the scraper posts to: `extension/` collects every vacancy card
on a listing page and `POST /api/vacancies/batch` turns the batch into one
`resumes.generate` message per vacancy, after validating the whole batch. Cards are
created *before* the message is published, so a scraped vacancy appears in **Created**
immediately - the worker's claim then adopts that same row (which is why the card turns
from *Tailoring In Progress* to *Tailored* in place).

There is **no signup**: an administrator creates accounts out of band. An account
provisioned with `--admin` also gets the **Vocabularies** page (`/admin`): the Action
list the dialogs suggest and the Filters panel offers, editable - while the Actor list,
the columns and the tailoring sub-states are shown read-only, because they are the
database's constraints and the board's own shape.

```powershell
kubectl port-forward svc/postgres 5432:5432      # keep both running
kubectl port-forward svc/rabbitmq 5672:5672
cd backoffice
npm install
Copy-Item .env.example .env                      # DATABASE_URL, BACKOFFICE_JWT_SECRET, RABBITMQ_URL
npm run user -- add --email me@example.com --password=secret --name Me --admin
npm run dev                                      # http://localhost:4321 -> sign in
```

Then load `extension/` unpacked (`chrome://extensions` -> Developer mode -> Load
unpacked), sign in there with the same account and press *Scrape & queue this page*.
`extension/README.md` has the step-by-step.

Refusing a vacancy is an **in-place archive**: the card keeps the column where it stopped
and is only muted (rose accent, struck-through title, `⛔️ Rejected by Company • Salary
mismatch`), so the board still shows where every application dropped out. A refused card
cannot be dragged, `🔄 Restore` puts it back in one click, and both changes are recorded
in the card's history with the actor and the reason. Archived cards are hidden until you
turn **Archived vacancies** on in the top bar's **🎛 Filters** panel, which is also where
the columns and the recorded Actions can be filtered - and the bar always reports
`showing N of M`, because the date range opens on the last 30 days.

## Your files

Everything the agent reads or writes lives on one volume, so nothing is lost when
the worker scales to zero:

```
/data/cv_data.json     structured CV model (must match cv.docx exactly)
/data/input/cv.docx    master CV
/data/input/jd_*.txt   job descriptions
/data/output/*.pdf     tailored results (+ .docx)
```

`scripts/storage-files.ps1` moves them in and out: `-Action seed` (push your CV),
`-Action list`, `-Action download`, `-Action shell`.

The board's *Tailored PDF / DOCX* links download through
`GET /api/artifacts/<job_id>`, which resolves the worker's stored path
(`/data/output/848944.pdf`) against `ARTIFACTS_DIR`/`OUTPUT_DIR`. A board running
outside the cluster therefore needs the volume mirrored locally - `-Action download`
writes exactly where the default root points (`artifacts\output\`).

**The hard sync rule:** every line of `cv_data.json` must exist verbatim in
`cv.docx`. The worker verifies this before touching the document and refuses the
task when they disagree, which is how it avoids rewriting the wrong paragraph.
Regenerate `cv_data.json` whenever the master CV changes.

## Configuration

Everything is environment-driven; `deploy/values/dev.yaml` supplies the cluster's
values and `charts/cv-tailoring-worker/templates/configmap.yaml` renders them.
For local CLI runs, copy `.env.example` to `.env`.

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | - | the only required external credential |
| `MODEL_NAME`, `PREFERRED_MODELS` | `gemini-3.5-flash` + ladder | model and comma-separated fallbacks; validated against the model list at start-up |
| `QUEUE_BACKEND` | `directory` | `amqp` in the cluster, `directory` (JSON files) for offline runs |
| `RABBITMQ_URL` (or `RABBITMQ_HOST/PORT/USERNAME/PASSWORD/VHOST`) | guest@localhost | broker address; the parts are composed, so the password can come from a Secret |
| `QUEUE_NAME` | `resumes.generate` | work queue |
| `PREFETCH_COUNT` | `1` | one message per worker |
| `MAX_ATTEMPTS` | `3` | redeliveries before the dead-letter queue |
| `DB_BACKEND` | `local` | `postgres` in the cluster, `local` (JSON file) for offline runs |
| `DATABASE_URL` | - | Postgres DSN |
| `MODEL_STATE_BACKEND` | `file` | `postgres` shares the model-fallback ledger between pods |
| `ARTIFACTS_DIR` | `artifacts/` | storage root; `/data` in the cluster |
| `LOG_FORMAT` | `text` | `json` for containers |
| `TEMP_ROOT` | `artifacts/temp` | per-job scratch dirs (`/tmp/cvt` in the image) |
| `MAX_REVISIONS`, `RENDER_DPI` | `3`, `70` | vision review loop |

## Tests and lint

```bash
python -m pytest -q        # offline: no network, no Gemini, no LibreOffice
python -m ruff check .
```

Covered: DOCX replacement semantics (multi-line label/value splitting, bullet
stripping, no-op dropping), `cv_data` against `cv.docx` sync validation, the
message contract (including the `job_id` shape guard), claim semantics (claimed /
duplicate / owned / re-claim), retry and dead-letter decisions, quota deferral,
model-availability TTL, queue semantics, and a full worker smoke test (queue ->
graph -> persist -> database row).

`tests/test_postgres_store.py` additionally runs against a **real** Postgres to
exercise the production schema, the claim SQL and the shared model ledger:

```bash
make test-postgres
```

## Project layout

```
agent/          contract, state, LangGraph nodes/graph, shared pipeline runner
utils/          queue, storage, db, model-state, retry, docx mutator, renderer, logging
worker.py       queue consumer (the pod entry point)
publisher.py    dev stand-in for the API gateway (host-side publish)
healthcheck.py  exec probes (liveness / readiness / render / amqp)
charts/         Helm charts: platform (RabbitMQ, KEDA, Postgres, storage) + worker
deploy/values/  environment values (dev.yaml = local cluster)
scripts/        local-deploy.ps1, send-test-job.ps1, storage-files.ps1, worker-secret.ps1, check_models.py
tests/          hermetic suite (+ Postgres-gated production-store tests)
docs/           architecture, contract, runbook + the layer map
```

## Deployment

The `Makefile` wraps the day-to-day commands (Windows users without `make` can
copy the recipe out of it - see `scripts/AGENTS.md`):

```bash
make local-deploy     # build, create the Secret, helm install the platform
make status           # pods, ScaledObject state and queue depth
make chart-lint       # lint both charts
make deploy           # helm upgrade --install into the current kube context
make rollback         # back to the previous release revision
make helm-test        # run the chart's in-cluster probe
make check-models     # verify MODEL_NAME against the models this key can use
```

CI runs two jobs on every push and pull request: `lint + tests` with a Postgres
service container, and `helm lint + render` (both charts, then the rendered
manifests checked with kubeconform).

## Documentation map

| File | Owns |
|---|---|
| `AGENTS.md` | the project map: layers, commands, conventions |
| `CONSTITUTION.md` | canonical architecture, invariants, known discrepancies |
| `docs/ARCHITECTURE.md` | how the code maps onto the design documents |
| `docs/MESSAGE_CONTRACT.md` | payload, ack/retry/dead-letter semantics, idempotency |
| `docs/RUNBOOK.md` | operations (queue backlog, dead letters, quota, rollback) |
| `<layer>/AGENTS.md` | the mechanical detail for one directory |

## Optional: managed clusters