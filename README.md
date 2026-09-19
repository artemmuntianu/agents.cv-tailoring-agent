# CV Tailoring Agent — self-hosted

Turns a job description into a CV tailored for it, as DOCX + PDF, using a
LangGraph pipeline (Gemini for the writing and the layout check, python-docx for
the document surgery, LibreOffice + poppler for the rendering).

Everything runs **on your own machine**, inside a local Kubernetes cluster:
the message queue, the autoscaler, the database and the file storage. The only
external call is to the **Gemini API**.

```
publisher / extension ──► RabbitMQ (rabbitmq-0, resumes.generate)
                              │   KEDA: queue depth → replicas (0 → M → 0)
                              ▼
                    ai-agent-worker pod (prefetch = 1, one vacancy per message)
                    adapt_text → render → vision_check → persist
                              │
              cv-artifacts volume (PDF/DOCX)  +  Postgres (status)
```

* `AGENTS.md` — the project map: layers, commands, conventions (read this first)
* `CONSTITUTION.md` — canonical architecture, invariants and known discrepancies
* `docs/PROJECT_STATE.md` — the point-in-time session handoff and resume point (history, not live status)

## Quickstart: the whole platform on your PC

Prerequisites, once:

1. **Docker Desktop** → *Settings → Kubernetes → Enable Kubernetes* (give Docker ~6 GB RAM).
2. `winget install Helm.Helm`, then open a **new** terminal.

```powershell
.\\scripts\\local-deploy.ps1
```

That builds the worker image, creates the Secret from `.env`, and installs
RabbitMQ, KEDA, Postgres, the artifact volume and the worker (0 replicas until
there is work).

Then put your CV on the cluster's volume and send a vacancy:

```powershell
.\\scripts\\storage-files.ps1 -Action seed        # push cv.docx + cv_data.json (+ any jd_*.txt)

kubectl port-forward svc/rabbitmq 5672:5672      # in a second terminal
$env:RABBITMQ_URL = (kubectl get secret rabbitmq-credentials -o jsonpath={.data.rabbitmq-url} | ForEach-Object { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_)) })
python publisher.py --jd your_job.txt

kubectl get pods -w                              # 0 -> 1 -> 0
.\\scripts\\storage-files.ps1 -Action download    # tailored PDFs into artifacts\\output
```

Teardown: `.\\scripts\\local-deploy.ps1 -Uninstall` (add
`kubectl delete pvc cv-artifacts` to drop the data as well).

## Your files

Everything the agent reads or writes lives on one PersistentVolumeClaim, so
nothing is lost when the worker scales to zero:

```
/data/cv_data.json     structured CV model (must match cv.docx exactly)
/data/input/cv.docx    master CV
/data/input/jd_*.txt   job descriptions
/data/output/*.pdf     tailored results (+ .docx)
```

`scripts/storage-files.ps1` moves them in and out: `-Action seed` (push your CV),
`-Action list`, `-Action download`, `-Action shell`.

**The hard sync rule:** every line of `cv_data.json` must exist verbatim in
`cv.docx`. The worker verifies this before touching the document and refuses the
task when they disagree — that is how it avoids rewriting the wrong paragraph.

## Without a cluster

The same pipeline also runs locally, with no Kubernetes at all:

```bash
pip install -r requirements-dev.txt

# 1. batch CLI over artifacts/input/jd_*.txt
python main.py

# 2. docker compose (RabbitMQ + Postgres containers)
docker compose up -d rabbitmq postgres
docker compose run --rm worker python publisher.py --all
docker compose up worker
```

`agent/pipeline.py` is shared by all three modes, so behaviour is identical.

## Configuration

Everything is environment-driven; `deploy/values/dev.yaml` supplies the
cluster's values and `charts/cv-tailoring-worker/templates/configmap.yaml`
renders them. For local CLI runs, copy `.env.example` to `.env`.

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | – | the only required external credential |
| `MODEL_NAME`, `PREFERRED_MODELS` | `gemini-3.5-flash` + ladder | model and comma-separated fallbacks; validated against `models.list()` at start-up |
| `QUEUE_BACKEND` | `directory` | `amqp` in the cluster, `directory` (JSON files) for offline runs |
| `RABBITMQ_URL` (or `RABBITMQ_HOST/PORT/USERNAME/PASSWORD/VHOST`) | guest@localhost | broker address; the parts are composed, so the password can come from a Secret |
| `QUEUE_NAME` | `resumes.generate` | work queue |
| `PREFETCH_COUNT` | `1` | one message per worker |
| `MAX_ATTEMPTS` | `3` | redeliveries before the dead-letter queue |
| `DB_BACKEND` | `local` | `postgres` in the cluster, `local` (JSON file) for offline runs |
| `DATABASE_URL` | – | Postgres DSN |
| `MODEL_STATE_BACKEND` | `file` | `postgres` shares the model-fallback ledger between pods |
| `ARTIFACTS_DIR` | `artifacts/` | storage root; `/data` in the cluster (PVC) |
| `LOG_FORMAT` | `text` | `json` for containers |
| `TEMP_ROOT` | `artifacts/temp` | per-job scratch dirs (`/tmp/cvt` in the image) |
| `MAX_REVISIONS`, `RENDER_DPI` | `3`, `70` | vision QA loop |

## Tests

```bash
python -m pytest -q        # offline: no network, no Gemini, no LibreOffice
python -m ruff check .
```

Covered: DOCX replacement semantics (multi-line label/value splitting, bullet
stripping, no-op dropping), `cv_data` ↔ `cv.docx` sync validation, the message
contract (including the `job_id` shape guard), claim semantics
(claimed / duplicate / owned / re-claim), retry and DLQ decisions, quota
deferral, model-availability TTL, queue semantics, and a full worker smoke test
(queue → graph → persist → database row).

`tests/test_postgres_store.py` additionally runs against a **real** Postgres
(service container in CI, `docker compose` locally) to exercise the production
schema, claim SQL and shared model ledger:

```bash
make test-postgres
```

## Layout

```
agent/          contract, state, LangGraph nodes/graph, shared pipeline runner
utils/          queue, storage, db, model-state, retry, docx mutator, renderer, logging
worker.py       queue consumer (the pod entry point)
main.py         batch CLI over local files
publisher.py    dev stand-in for the API gateway
healthcheck.py  exec probes (liveness / readiness / render / amqp)
charts/         Helm charts: platform (RabbitMQ, KEDA, Postgres, storage) + worker
deploy/values/  environment values (dev.yaml = local cluster)
scripts/        local-deploy.ps1, storage-files.ps1, worker-secret.ps1, check_models.py
docs/           the CommonAgentSDK layered-docs standard (template_agents.md)
```

## Optional: managed clusters

The charts are not tied to a local cluster — point them at a managed Kubernetes
cluster, give the worker a registry-hosted image and a `nodeSelector` for your
node pools, and the same deployment works there (`charts/AGENTS.md` documents the
scaling and cost knobs). Nothing in the worker code assumes either topology.
