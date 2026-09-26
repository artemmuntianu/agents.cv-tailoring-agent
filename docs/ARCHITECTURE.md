# Architecture (implementation map)

How the code maps onto the design documents, and what the running system looks like
on the machine it is deployed to. There is **one supported runtime**: a local
single-node Kubernetes cluster (Docker Desktop on the dev machine), installed with
`.\scripts\local-deploy.ps1`. No cloud account, and the only outbound call is the
Gemini API. Invariants live in `CONSTITUTION.md` (§4, §9), operations in
`docs/RUNBOOK.md`, the queue payload in `docs/MESSAGE_CONTRACT.md`.

## 1. Topology (read back from a live install)

```
                    ┌───────────────── external, the only egress ─────────────────┐
                    │ Gemini API  (adapt_text, vision_check)                      │
                    └──────────────▲──────────────────────────────────────────────┘
                                   │ HTTPS
  host (Windows)            ┌──────┴─────────── cluster: docker-desktop, ns default
  ──────────────            │
   send-test-job.ps1        │  ┌──────────────────────── broker ──────────────────────────┐
    port-forward 5672 ─AMQP─┼─►│ StatefulSet rabbitmq → pod rabbitmq-0   (Svc rabbitmq)   │
   storage-files.ps1        │  │  5672 AMQP · 15672 management · PVC data-rabbitmq-0      │
    kubectl cp (cv-files) ──┼─►│  CM rabbitmq-config → conf.d/10-cv-tailoring.conf        │
   local-deploy.ps1         │  │  Secret rabbitmq-definitions  (vhost + user + topology)  │
    build · secret · helm   │  │  Secret rabbitmq-credentials  (amqp url, management url) │
                            │  └───────┬──────────────────────────────────────▲───────────┘
                            │          │ queue resumes.generate               │ HTTP 15672
                            │          │ (ready + unacked)                    │
                            │  ┌───────▼──────────────────────────────────────┴───────────┐
                            │  │ KEDA 2.15.2: operator · metrics-apiserver · webhooks     │
                            │  │  ScaledObject ai-agent-worker   0..3, poll 10s, cool 60s │
                            │  │  TriggerAuthentication → Secret rabbitmq-credentials     │
                            │  │   protocol: http, host = rabbitmq-management-url         │
                            │  └───────┬──────────────────────────────────────────────────┘
                            │          │ HPA keda-hpa-ai-agent-worker → replicas
                            │  ┌───────▼──────────────────────────────────────────────────┐
                            │  │ Deployment ai-agent-worker (0 ⇄ 3; KEDA owns replicas)   │
                            │  │  image cv-tailoring-worker:dev = python 3.12 +           │
                            │  │  LibreOffice + poppler + Carlito/Caladea fonts           │
                            │  │  uid:gid 10001 · prefetch 1 · grace 120s · heartbeat 600s│
                            │  │  env ← CM ai-agent-worker + Secret cv-tailoring-secrets  │
                            │  │        + RABBITMQ_HOST/USER/PASS from the broker Secret  │
                            │  └───┬──────────────────────────────────────────┬───────────┘
                            │      │ /data (PVC cv-artifacts)                 │ SQL
                            │  ┌───▼────────────────────┐        ┌────────────▼────────────┐
                            └─►│ Deploy cv-files        │        │ Deploy postgres         │
                               │  busybox, same PVC;    │        │  Svc postgres:5432      │
                               │  chowns input/ +       │        │  PVC postgres-data      │
                               │  output/ → 10001:10001 │        │  Secret local-postgres  │
                               └────────────────────────┘        └─────────────────────────┘
```

Two independent paths keep the worker alive: the **management HTTP API** (KEDA reads
queue depth) and **AMQP** (the worker consumes). They use different credentials keys
of the same Secret, so the password still exists once.

## 2. Pod groups ↔ this repo

| Doc group | Live objects | Where |
|---|---|---|
| ① Broker | `StatefulSet/rabbitmq` → `pod/rabbitmq-0`, `Svc/rabbitmq` 5672+15672, `PVC/data-rabbitmq-0`, `CM/rabbitmq-config`, `Secret/rabbitmq-definitions`, `Secret/rabbitmq-credentials` | `charts/cv-tailoring-platform/templates/rabbitmq.yaml`, `.../definitions.yaml`, `.../rabbitmq-credentials.yaml` |
| ② Workers | `Deployment/ai-agent-worker` (0 ⇄ N) + `ScaledObject/ai-agent-worker` + `TriggerAuthentication/ai-agent-worker-rabbitmq` + `CM/ai-agent-worker` | `charts/cv-tailoring-worker` |
| ③ Autoscaler | `keda-operator`, `keda-operator-metrics-apiserver`, `keda-admission-webhooks` | `kedacore/keda` subchart (the only upstream chart) |
| ④ State | `Deploy/postgres` + `Svc/postgres` 5432 + `PVC/postgres-data` + `Secret/local-postgres` | `charts/cv-tailoring-platform/templates/local-postgres.yaml` |
| ⑤ Artifacts | `PVC/cv-artifacts` (2 Gi, hostpath, `keep`) + `Deploy/cv-files` | `charts/cv-tailoring-platform/templates/storage.yaml` |

The producer in the source design is Chrome extension → Vercel gateway → AMQP. Locally
there are two producers and both publish the identical payload shape, so nothing
downstream knows the difference:

* `extension/` (Chrome MV3, loaded unpacked) scrapes every vacancy card on a listing
  page and posts the batch to the backoffice gateway
  (`POST /api/vacancies/batch` in `backoffice/`), which validates the batch and
  publishes one message per vacancy - see `CONSTITUTION.md` D12;
* `publisher.py` (driven by `scripts/send-test-job.ps1`) publishes a single job from
  the host, which is what a smoke test needs.

## 3. Message and task flow

```
publish ─► resumes.generate ─► KEDA sees depth > 0 ─► HPA ─► replicas 0 → 1
             │                                                     │
             │                                    pod start: preflight (db.ping,
             │                                    LibreOffice, poppler, models.list)
             ▼                                                     │
      consume (prefetch 1, manual ack) ◄──────────────────────────┘
             │
   handle_delivery: idempotency (find_completed) ─► claim row (postgres, attempts++)
             │                                   ─► storage.prepare_task
             │                                      (/data/cv_data.json + input/cv.docx,
             │                                       whitespace sync check)
             │
   LangGraph: adapt_text ─► render (soffice → PDF) ─► vision_check (pdftoppm → PNG → Gemini)
                   ▲                ▲                                  │  ≤ MAX_REVISIONS
                   └── revisions ───┘                                   ▼
                                                                persist ◄┘
                                    /data/output/cv_<id>.docx + .pdf, row status=completed
             │
        ack (only after persist) ─► depth 0 ─► cooldown ─► replicas → 0
             │
   deferral: 429 / quota ─► RetryLater ─► retry TTL queue ─► back to resumes.generate
              (row=rate_limited, the model is written to the model_availability ledger)
   failure:  exception ─► retry ─► resumes.generate (attempts++) ─► attempts ≥ 3 ─► DLX ─► DLQ
```

Queue topology as declared (chart definitions, byte-identical in intent to
`utils/messaging.py::_declare_topology`):

| Entity | Kind | Arguments / routing |
|---|---|---|
| `resumes.generate` | durable queue | `x-dead-letter-exchange=resumes.generate.dlx`, `x-dead-letter-routing-key=resumes.generate.dlq` |
| `resumes.generate.dlx` | direct exchange, durable | — |
| `resumes.generate.dlq` | durable queue | bound to the DLX with routing key `resumes.generate.dlq` |
| `resumes.generate.retry.{60,300,900,1800,3600}s` | durable queues | `x-message-ttl=<rung>`, `x-dead-letter-exchange=""` → straight back to `resumes.generate` |
| `vacancies.parse`, `applications.submit` | durable queues | declared, unused today |

## 4. Per-task pipeline (design steps a–g)

| Doc step | Code |
|---|---|
| a) fetch 1 task (`description_raw` + `cv_data.json`) | `worker.handle_delivery` → `utils/storage.prepare_task` |
| b) LangGraph gap analysis (Gemini) | `agent/nodes.adapt_text` (+ `_call_gemini_extract_role`) |
| c) AST/XML mutation of master `cv.docx` | `utils/docx_mutator.apply_text_replacements` |
| d) render DOCX → PDF → images | `utils/renderer` (LibreOffice + poppler, per-job profile) |
| e) Vision QA | `agent/nodes.vision_check` (loop ≤ `MAX_REVISIONS`) |
| f) store the result | `agent/nodes.persist` → `utils.storage.LocalStorage` (the `cv-artifacts` volume) |
| g) update PostgreSQL state | `agent/nodes.persist` → `utils/db.PostgresDb` |

The message is acked only after (f) and (g) succeed.

### Ingest: how a message gets there, and why the card is instant

| Step | Code |
|---|---|
| scrape the listing page | `extension/` (`div[id^="job-item-"]`, injected function) |
| authenticate, validate the whole batch | `POST /api/vacancies/batch` → `backoffice/src/lib/vacancies.ts` (pure) |
| **create the board card** | `resumes` row, `status='submitted'` → `backoffice/src/lib/ingest.ts` |
| publish one message per vacancy | `backoffice/src/lib/queue.ts` (mirrors `utils/messaging.py`) |

The row is committed *before* the message, which is what puts a scraped vacancy in
Created immediately instead of only after KEDA boots a worker - and the worker's claim
then **adopts** that same row (`job_id` unchanged), because `submitted` is deliberately
outside `ACTIVE_STATUSES`. If the publish fails the gateway deletes the rows it created
(`on conflict do nothing` + a `status='submitted'` guard make both steps safe against a
concurrent scrape).

Results come back the same way: `resumes.pdf_url`/`docx_path` are paths on the
`cv-artifacts` volume, so the board serves `GET /api/artifacts/<job_id>` (resolved
against `ARTIFACTS_DIR`; mirror the volume with `scripts/storage-files.ps1 -Action
download` when the board runs outside the cluster).

An **archived** (refused) vacancy is a duplicate too, whatever its tailoring status says:
`findExistingVacancies` reads `resume_board.archived_at`, so re-scraping a page can never
re-queue a card the operator has closed (invariant 19).

## 5. Scaling and lifecycle invariants (values as deployed by `deploy/values/dev.yaml`)

| Knob | Value | Why it matters here |
|---|---|---|
| `keda.minReplicaCount` / `maxReplicaCount` | 0 / 3 | 0 → N → 0; the Deployment renders no `replicas` while KEDA is enabled |
| `keda.mode` / `queueLength` / `activationValue` | `QueueLength` / `1` / `0` | one pod per waiting vacancy |
| `keda.protocol` | **`http`** (+ the management URL from the Secret) | the count must include **unacknowledged** messages - the AMQP count is ready-only, so a prefetched job would look like an empty queue and KEDA would scale a working pod to zero |
| `keda.pollingInterval` / `cooldownPeriod` | 10 s / 60 s | how fast a vacancy wakes a pod, and how long a drained queue waits before scaling down |
| `keda.fallback` | threshold 3, replicas 1 | if the scaler cannot reach the broker, one worker stays alive instead of stalling |
| `PREFETCH_COUNT` | 1 | one task per pod; with `queueLength=1` this is what makes "20 vacancies → 20 pods" |
| `terminationGracePeriodSeconds` | 120 s | SIGTERM (scale-down, rolling update) lets the in-flight task finish and be acked |
| `AMQP_HEARTBEAT_SECONDS` | 600 s | must exceed the longest task: pika cannot service heartbeats while the graph runs |
| `MAX_ATTEMPTS` | 3 | poison-message protection before the message is parked in the DLQ |
| `MAX_REVISIONS` / `RENDER_DPI` | 3 / 70 | vision-check loop budget and the PNG resolution it reads |
| probes | liveness `--mode liveness`, readiness `--mode readiness` | readiness reads the heartbeat file, which the worker refreshes periodically, so an **idle** worker stays Ready |

Provider selection (`QUEUE_BACKEND`, `DB_BACKEND`, `MODEL_STATE_BACKEND`) is what the
hermetic test suite switches on; the deployed configuration is always
amqp / postgres / postgres, as `deploy/values/dev.yaml` sets.

## 6. Storage layout and ownership

```
/data  (PVC cv-artifacts, 2Gi RWO, StorageClass hostpath, helm.sh/resource-policy: keep)
├── cv_data.json      seeded; must match the master DOCX (checked at task time)
├── input/
│   ├── cv.docx       master CV, read by every task
│   └── jd_*.txt      optional batch descriptions (the queue message carries the JD)
└── output/           owned by 10001:10001 - the worker writes here
    └── cv_<external_id>.docx + .pdf
```

* The worker runs unprivileged (`runAsUser/runAsGroup/fsGroup: 10001`) with
  `/tmp/cvt` as an `emptyDir`.
* `cv-files` (busybox) mounts the same PVC, chowns `input/` + `output/` to
  `fileManager.owner` (10001:10001) on start and then idles: that is what keeps
  `kubectl cp` usable while the worker is scaled to zero, and what stops the first
  task from dying with `Permission denied: '/data/output/...'`.
* `/data` is the only place task input and output live; nothing is baked into the image.

## 7. What owns what

| Object | Created by | Notes |
|---|---|---|
| Release + every namespaced object, `rabbitmq-credentials`, `rabbitmq-definitions`, `local-postgres` | `helm release cv-tailoring` | one `helm upgrade --install` of `charts/cv-tailoring-platform` |
| `Secret cv-tailoring-secrets` (`GEMINI_API_KEY`, `DATABASE_URL`) | `scripts/worker-secret.ps1` | values come from `.env`, never from git |
| Worker non-secret env (`CM ai-agent-worker`) | `deploy/values/dev.yaml` → chart values → `configmap.yaml` | the single values→env mapping (`charts/AGENTS.md`) |
| Replica count | KEDA (`ScaledObject` → HPA) | the Deployment must not set `replicas` while KEDA is enabled |
| KEDA CRDs | the `keda` subchart | shipped as **templates**, so the first install runs in two phases (`scripts/local-deploy.ps1`) |
| `PVC cv-artifacts` | chart, kept on uninstall | task data outlives the release by design |

## 8. Deliberate deviations from the source docs

* **One runtime, no cloud.** The design documents describe Azure Container Apps / AKS
  (a system node pool for the broker, an autoscaled pool for the workers). This repo
  runs the same charts on one local node and calls nothing but the Gemini API.
* **Model state moved to Postgres.** A per-pod `model_state.json` is clobbered by
  parallel pods and lost at scale-to-zero, defeating the fallback design.
* **Retry ladder instead of waiting.** A pod has no TTY, so hitting a daily quota
  raises `RetryLater` (TTL queue) rather than blocking on `input()`.
* **Per-task `cv_data`.** The old code read `cv_data.json` into an import-time
  global; the payload now carries it (or it is fetched per task), which also
  removes a cross-tenant staleness bug.
* **No ingress/service.** The worker only pulls work; probes are exec-based.
* **Storage is a local volume**, not a cloud bucket: one PVC holds the master CV,
  the job descriptions and every tailored result.
