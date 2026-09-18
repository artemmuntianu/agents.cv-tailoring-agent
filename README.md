# CV Tailoring Agent — event-driven cloud worker

Turns a local LangGraph CV-tailoring CLI into an **event-driven Kubernetes
worker**: one RabbitMQ message per vacancy, KEDA scaling `0 → M → 0`, results
uploaded to Supabase Storage with state written to Postgres and pushed to the
dashboard through Supabase Realtime.

```
Chrome Extension → Vercel API gateway → RabbitMQ (rabbitmq-0, resumes.generate)
                                              │  KEDA: queue depth → replicas
                                              ▼
                            ai-agent-worker pod (prefetch=1, 15–45 s per task)
                       adapt_text → render → vision_check → persist
                                              │
                    Supabase Storage (PDF/DOCX) + Postgres (status) → Realtime → UI
```

* `docs/ARCHITECTURE.md` — how this repo maps onto the two design documents
* `docs/MESSAGE_CONTRACT.md` — payload, ack/retry/DLQ semantics, idempotency
* `docs/RUNBOOK.md` — operations (queue backlog, DLQ, quota, rollback)
* `deploy/infra/` — AKS cluster (system pool + 0→N workload pool)
* `charts/` — standard Helm charts (Bitnami RabbitMQ, KEDA, this worker)

## Quickstart (no cloud, no broker)

```bash
pip install -r requirements-dev.txt

# 1. batch mode: every jd_*.txt in artifacts/input (as before)
artifacts/input/cv.docx        # master CV
artifacts/cv_data.json         # structured CV model describing that DOCX
artifacts/input/jd_1.txt       # job description
python main.py

# 2. queue mode with a filesystem queue (no RabbitMQ needed)
python publisher.py --all                # -> artifacts/queue/incoming/
python worker.py --once                  # drains it, writes artifacts/output/
```

Probe the environment at any time:

```bash
python healthcheck.py --mode all         # render tools, dirs, heartbeat, broker
```

## Quickstart with real infrastructure (local)

```bash
cp .env.example .env                     # set GEMINI_API_KEY (+ Supabase/Postgres)
docker compose up -d rabbitmq postgres   # local broker + job store
docker compose run --rm worker python publisher.py --all
docker compose up worker                 # consumes resumes.generate
open http://localhost:15672              # RabbitMQ management UI (cvt/cvt)
```

## Run it on your own PC (no cloud, EUR 0)

Prerequisites, once:
1. Docker Desktop -> **Settings -> Kubernetes -> Enable Kubernetes** (give Docker ~6 GB of RAM).
2. `winget install Helm.Helm`, then open a **new** terminal.

```powershell
.\scripts\local-deploy.ps1        # build image -> secret -> helm install -> wait
```

That brings up, inside your own cluster: RabbitMQ (`rabbitmq-0`), KEDA, a local
Postgres, the worker (0 replicas until there is work) **and the artifact
storage** - a PersistentVolumeClaim called `cv-artifacts`, not a cloud bucket.
The only external dependency left is the **Gemini API**.

Files live on that volume, and are moved in/out through a tiny `cv-files` pod
(the worker is usually scaled to zero):

```powershell
.\scripts\storage-files.ps1 -Action seed       # push cv.docx + cv_data.json (+ any jd_*.txt)
.\scripts\storage-files.ps1 -Action list       # what is on the volume
.\scripts\storage-files.ps1 -Action download   # pull tailored PDFs into artifacts\output
```

```
/data/cv_data.json     structured CV model (must match cv.docx exactly)
/data/input/cv.docx    master CV
/data/input/jd_*.txt   job descriptions for `python main.py` batches
/data/output/*.pdf     tailored results
```

Send one vacancy and watch KEDA wake a pod and put it back to sleep:

```powershell
kubectl port-forward svc/rabbitmq 5672:5672
$env:RABBITMQ_URL = (kubectl get secret rabbitmq-credentials -o jsonpath={.data.rabbitmq-url} | ForEach-Object { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_)) })
python publisher.py --jd your_job.txt
kubectl get pods -w                     # 0 -> 1 -> 0
```

Teardown: `.\scripts\local-deploy.ps1 -Uninstall`

## Deploy to Kubernetes (Helm)

```bash
kind create cluster --name cvtailoring           # or AKS via deploy/infra/aks.bicep
helm dependency update charts/cv-tailoring-platform
make dev-secret                                  # Secret from .env, never from git
helm upgrade --install cv-tailoring charts/cv-tailoring-platform \
  -f deploy/values/dev.yaml --set cv-tailoring-worker.image.tag=dev --wait
kubectl exec -it rabbitmq-0 -- rabbitmqctl list_queues name messages
```

Generic (no `make`): `make help` lists every target, and each one is a plain
shell command you can copy.

## Configuration

Everything is environment-driven (see `.env.example` for the full list).

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | – | Gemini API key (falls back to ADC) |
| `MODEL_NAME`, `PREFERRED_MODELS` | placeholder ladder | model + **comma-separated** fallbacks; validated at start-up against `models.list()` || `QUEUE_BACKEND` | `directory` | `directory` \| `amqp` |
| `RABBITMQ_URL` | `amqp://guest:guest@localhost:5672/%2F` | broker (in cluster: `amqp://…@rabbitmq.default.svc.cluster.local:5672/%2F`) |
| `QUEUE_NAME` | `resumes.generate` | work queue |
| `PREFETCH_COUNT` | `1` | one message per worker |
| `MAX_ATTEMPTS` | `3` | redeliveries before the DLQ |
| `STORAGE_BACKEND` | `local` | `local` \| `supabase` |
| `DB_BACKEND` | `local` | `local` \| `postgres` |
| `MODEL_STATE_BACKEND` | `file` | `file` \| `postgres` (shared ledger) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_BUCKET` | – | artifact storage |
| `DATABASE_URL` | – | Supabase/Postgres DSN |
| `DB_PREPARE_STATEMENTS` | `false` | keep `false` for Supabase's pooled (6543) endpoint; `true` only for direct/session connections |
| `LOG_FORMAT` | `text` | `text` (dev) \| `json` (containers) |
| `TEMP_ROOT` | `artifacts/temp` | per-job working dirs (`/tmp/cvt` in the image) |
| `MAX_REVISIONS`, `RENDER_DPI` | `3`, `70` | vision QA loop |
| `INTERACTIVE_QUOTA_WAIT` | `auto` | `auto` prompts only when a TTY is attached |

## Tests & validation

```bash
python -m pytest -q        # 31 hermetic tests: no network, no Gemini, no LibreOffice
python -m ruff check .
```

Covered: DOCX replacement semantics (multi-line label/value splitting, bullet
stripping, no-op dropping), `cv_data` ↔ `cv.docx` sync validation, message
contract (incl. the `job_id` shape guard), claim semantics
(claimed/duplicate/owned/re-claim), retry/DLQ decisions, quota deferral,
model-availability TTL, directory-queue semantics, and a full worker smoke test
(queue → graph → persist → DB row).

`tests/test_postgres_store.py` additionally exercises the **real** Postgres data
plane (schema, non-UUID `job_id`, shape constraint, attempts, claim paths, shared
model ledger). It is skipped unless `TEST_DATABASE_URL` is set, and CI provides a
`postgres:16` service container so it always runs there:

```bash
TEST_DATABASE_URL=postgresql://cvt:cvt@localhost:5432/cvt python -m pytest -q tests/test_postgres_store.py
```

CI additionally lints and renders both charts and (on chart changes) installs the
worker into a **kind** cluster with offline backends to prove the image and the
exec probes work.

## Before the first production deploy

```bash
python scripts/check_models.py --strict   # MODEL_NAME must exist for your key
./scripts/prod-secrets.sh                 # the 3 Secrets the chart expects
helm upgrade --install cv-tailoring charts/cv-tailoring-platform \
  -f deploy/values/prod.yaml \
  --set cv-tailoring-worker.existingSecret=cv-tailoring-secrets \
  --set cv-tailoring-worker.keda.maxReplicaCount=2 \
  --atomic --wait
```

Then publish **one** real vacancy, confirm the row reaches `completed` with a
working signed `pdf_url` (pods `0 → 1 → 0`, DLQ empty) and only then raise
`maxReplicaCount`. The full sequence, guardrails and acceptance criteria are in
`docs/RUNBOOK.md`.

Prerequisites that live outside this repo: a Supabase project (schema +
policies + `resumes` bucket + master `cv.docx`/`cv_data.json` uploaded), a Gemini
API key, and a cluster (`deploy/infra/aks.bicep`).

## Layout

```
agent/          contract, state, LangGraph nodes/graph, shared pipeline runner
utils/          queue, storage, db, model-state, retry, docx mutator, renderer, logging
worker.py       RabbitMQ consumer (the pod entry point)
main.py         local batch CLI (unchanged behaviour)
publisher.py    dev stand-in for the Vercel gateway
healthcheck.py  exec probes (liveness / readiness / render / amqp)
charts/         standard Helm charts (worker + umbrella)
deploy/         per-env values + AKS Bicep
docs/           architecture, message contract, runbook, SQL schema
```
