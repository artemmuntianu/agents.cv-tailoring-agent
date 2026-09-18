# Architecture (implementation map)

This repository implements the **AI worker layer** of the event-driven design
described in the two source documents, plus the Helm/k8s deployment around it.

```
Chrome Extension ──HTTPS──► Vercel API Gateway ──AMQP──► RabbitMQ (rabbitmq-0)
                                                              │
                                       KEDA ScaledObject (queue depth 0→M) │
                                                              ▼
                            ai-agent-worker pod(s)  ── prefetch_count = 1
                              adapt_text → render → vision_check → persist
                                                              │
                       Supabase Storage (PDF/DOCX) + Postgres (status) ──► Realtime ──► UI
```

## Pod groups ↔ this repo

| Doc group | Objects | Where |
|---|---|---|
| ① Broker | `rabbitmq-0` StatefulSet, 100m/500m CPU, 256Mi/512Mi, always on | Bitnami `rabbitmq` subchart (`helm/cv-tailoring-platform`) |
| ② Workers | `ai-agent-worker-*` Deployment + ScaledObject, 250m/1000m CPU, 512Mi/1024Mi, **0 → M → 0** | `charts/cv-tailoring-worker` |
| ③ Autoscaler | `keda-operator`, `keda-metrics-server` | `kedacore/keda` subchart |

`prefetch_count=1` (`PREFETCH_COUNT`) and `keda.mode: QueueLength`
(`ready + unacked`) are what make "20 vacancies → 20 pods" behave correctly with
15–45 s tasks: in-flight work still counts, so KEDA cannot scale to zero while
messages are being processed.

## Node pools ↔ `deploy/infra/aks.bicep`

| Pool | Size | Contents |
|---|---|---|
| `system` (tainted `workload=system`) | `Standard_B2s` (2 vCPU / 4 GB), always on | RabbitMQ, KEDA, ingress |
| `workload` | autoscaled **0 → N** | `ai-agent-worker` pods (`nodeSelector: nodepool=workload`) |

## Per-task pipeline (Doc B steps a–g)

| Doc step | Code |
|---|---|
| a) fetch 1 task (`description_raw` + `cv_data.json`) | `worker.handle_delivery` → `utils/storage.prepare_task` |
| b) LangGraph gap analysis (Gemini) | `agent/nodes.adapt_text` (+ `_call_gemini_extract_role`) |
| c) AST/XML mutation of master `cv.docx` | `utils/docx_mutator.apply_text_replacements` |
| d) render DOCX → PDF → images | `utils/renderer` (LibreOffice + poppler, per-job profile) |
| e) Vision QA | `agent/nodes.vision_check` (loop ≤ `MAX_REVISIONS`) |
| f) upload result to Supabase Storage | `agent/nodes.persist` → `utils/storage.SupabaseStorage` |
| g) update PostgreSQL state | `agent/nodes.persist` → `utils/db.PostgresDb` → Realtime |

The message is acked only after (f) and (g) succeed.

## Why the local CLI still works

Everything provider-specific sits behind an env-selected backend, so the same
graph runs three ways:

| Backend | Local dev / tests | Cluster |
|---|---|---|
| queue | `directory` (JSON files) | `amqp` (RabbitMQ) |
| storage | `local` (artifacts/) | `supabase` |
| db | `local` (JSON file) | `postgres` |
| model state | `file` | `postgres` (shared ledger) |

`python main.py` (batch over `artifacts/input/jd_*.txt`) and `python worker.py`
(queue consumer) share `agent/pipeline.py`, so there is exactly one
implementation of the tailoring flow.

## Deliberate deviations from the source docs

* **Model state moved to Postgres.** A per-pod `model_state.json` is clobbered by
  parallel pods and lost at scale-to-zero, defeating the fallback design.
* **Retry ladder instead of waiting.** A pod has no TTY, so hitting a daily quota
  raises `RetryLater` (TTL queue) rather than blocking on `input()`.
* **Per-task `cv_data`.** The old code read `cv_data.json` into an import-time
  global; the payload now carries it (or it is fetched per task), which also
  removes a cross-tenant staleness bug.
* **No ingress/service.** The worker only pulls work; probes are exec-based.
* **Storage over REST (`httpx`)** rather than the Supabase SDK, keeping the image
  lean and the surface small.
