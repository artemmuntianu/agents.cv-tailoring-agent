# Message contract

One AMQP message == one vacancy == one LangGraph run.

## Queue topology

| Object | Name | Notes |
|---|---|---|
| Queue | `resumes.generate` | durable, consumed with `prefetch_count=1` |
| Exchange | `resumes.generate.dlx` (direct) | dead-letter target |
| Queue | `resumes.generate.dlq` | poison messages (invalid payload, attempt limit) |
| Queue | `resumes.generate.retry.{60,300,900,1800,3600}s` | TTL queues, auto-declared by the worker; `RETRY_LATER` picks the smallest rung ≥ the requested delay |
| Queues | `vacancies.parse`, `applications.submit` | declared for the gateway/extension side |

Backpressure: the worker declares the topology on connect (`utils/messaging.py`),
so the queues exist even before the definitions Secret is loaded.

## Publishing (Vercel API gateway, or `publisher.py` locally)

The Chrome extension scrapes every card (`div[id^="job-item-"]`) and POSTs a
batch; the gateway publishes **N individual messages**:

```json
{
  "job_id": "848944-1789668742",
  "user_id": "3f0f2a7c-...",
  "external_id": "848944",
  "title": "Platform Engineering Lead",
  "company": "UPPeople",
  "source_url": "https://djinni.co/jobs/848944/",
  "description_raw": "About the Role\nWe are looking for ...",
  "cv_version": "v1",
  "attempt": 0,
  "enqueued_at": "2026-09-17T19:12:02+00:00",
  "cv_data": { "header": {...}, "summary": "...", "skills": {...}, "professional_experience": [...] }
}
```

| Field | Required | Notes |
|---|---|---|
| `job_id` | no | opaque row id; generated when absent. **Not required to be a UUID** |

### `job_id` semantics (decision "option A")

`job_id` is the **row identity**, not a business key — it is stored as `text`
and may be `848944-1789668742`, a UUID, or any token matching
`^[A-Za-z0-9_.:-]{4,80}$`. Rules:

* the gateway may bring its own id (readable ids are fine for logs/support);
* omitting it makes the worker generate a UUID;
* the **business identity** is `(user_id, external_id, cv_version)`, enforced by
  `resumes_job_key_idx` — that is what a dashboard correlates on;
* if a message reuses a `job_id` that belongs to a *different* vacancy the worker
  refuses to touch the foreign row and acks the message (`outcome=owned`);
* if the vacancy is already in flight or completed by another task, the message is
  acked as a duplicate (`outcome=duplicate`) and no LLM call is made;
* a retry of a *failed* task re-claims the **existing row** (same `job_id`), which
  keeps one row per vacancy and preserves the attempt counter.
| `external_id` | **yes** | vacancy id; with `user_id` + `cv_version` it forms the idempotency key |
| `description_raw` | **yes** | plain text (HTML already stripped) |
| `cv_data` | no | inline CV model; when absent the worker downloads `master/cv_data.json` |
| `cv_version` | no | bump it when the master CV changes to force re-tailoring |
| `attempt` | no | informational; the authoritative counter lives in Postgres |

**Hard sync rule:** every line of `cv_data` must exist verbatim in the master
`cv.docx`. The worker verifies this (`validate_cv_data_against_docx`) and fails
the task with `invalid_master_cv`-style error rather than mutating the wrong
paragraph.

## Acknowledgement semantics

| Handler result | Broker action | When |
|---|---|---|
| `ACK` | `basic_ack` | task completed and the artifacts are persisted; **or** the job is already `completed` (duplicate delivery) |
| `RETRY` | `basic_nack(requeue=True)` | transient failure; `attempts < MAX_ATTEMPTS` |
| `RETRY_LATER` | publish to the TTL retry queue, then ack | Gemini daily quota exhausted (`RetryLater`), or the job store/inputs are temporarily unavailable |
| `DEAD_LETTER` | publish to the DLQ, then ack | schema-invalid payload, or `attempts >= MAX_ATTEMPTS` |

Key property: the worker **acks only after `persist` succeeded**, so a crash,
OOM-kill or scale-down mid-task simply redelivers the message.

## Status lifecycle (Postgres → dashboard)

```
queued → processing → rendering → validating → uploading → completed
                                     ↘ failed → (retry) → dead_lettered
                                     ↘ rate_limited → (delayed retry)
                                     ↘ skipped        (no replacement matched)
```

`resumes.pdf_url` / `docx_path` receive the artifact's path on the cluster
volume (`/data/output/...`); pull files out with
`scripts/storage-files.ps1 -Action download`.

## Idempotency

Key: `coalesce(user_id,'local') : external_id : cv_version`, enforced by
`resumes_job_key_idx`. A redelivered or duplicated message therefore never pays
for Gemini twice — the worker detects the completed row, logs
`already completed - acking duplicate` and acks.

## Local (directory) backend

With `QUEUE_BACKEND=directory` messages are JSON files:
`artifacts/queue/incoming/ → inflight/ → processed|failed|retry/`, and retries
bump `attempt` in the file itself. Same handler, same semantics, no broker.
