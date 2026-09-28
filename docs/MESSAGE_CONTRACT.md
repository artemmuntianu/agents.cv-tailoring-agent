# Message contract

One AMQP message == one vacancy == one LangGraph run.

## Queue topology

| Object | Name | Notes |
|---|---|---|
| Queue | `resumes.generate` | durable, consumed with `prefetch_count=1` |
| Exchange | `resumes.generate.dlx` (direct) | dead-letter target |
| Queue | `resumes.generate.dlq` | poison messages (invalid payload, attempt limit) |
| Queue | `resumes.generate.retry.{60,300,900,1800,3600}s` | TTL queues, auto-declared by the worker; `RETRY_LATER` picks the smallest rung ≥ the requested delay |
| Queue | `resumes.cover` | durable, consumed by `cover.py` with `prefetch_count=1` |
| Exchange | `resumes.cover.dlx` (direct) | dead-letter target of the cover queue |
| Queue | `resumes.cover.dlq` | poison cover-letter requests |
| Queues | `resumes.cover.retry.{60,300,900,1800,3600}s` | the same TTL ladder, declared by `cover.py` |
| Queues | `vacancies.parse`, `applications.submit` | declared for the gateway/extension side |

Backpressure: the worker declares the topology on connect (`utils/messaging.py`),
so the queues exist even before the definitions Secret is loaded.

## Publishing (the board's move route, or `publisher.py` / `send-test-job.ps1`)

The Chrome extension scrapes every card (`div[id^="job-item-"]`) and POSTs a batch; the board
creates **one card per vacancy** in its Scraped column and queues nothing at all. The message
is published when the operator drags that card into **Prepare** (`POST /api/board/move`), or
by the host-side tools below - one payload per vacancy either way:

```json
{
  "job_id": "848944-1789668742",
  "user_id": "3f0f2a7c-...",
  "external_id": "848944",
  "source": "djinni",
  "title": "Platform Engineering Lead",
  "company": "UPPeople",
  "source_url": "https://djinni.co/jobs/848944/",
  "description_raw": "About the Role\nWe are looking for ...",
  "cv_version": "v1",
  "attempt": 0,
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
| `external_id` | **yes** | vacancy id; with `user_id` + `source` + `cv_version` it forms the idempotency key |
| `source` | no | site slug (`djinni`, `dou`, ...); defaults to `djinni`. Two sites number their vacancies independently, so it is half of the vacancy's identity |
| `description_raw` | **yes** | plain text (HTML already stripped) |
| `cv_data` | no | inline CV model; when absent the worker downloads `master/cv_data.json` |
| `cv_version` | no | bump it when the master CV changes to force re-tailoring |
| `attempt` | no | informational; the authoritative counter lives in Postgres |

**Hard sync rule:** every line of `cv_data` must exist verbatim in the master
`cv.docx`. The worker verifies this (`validate_cv_data_against_docx`) and fails
the task with `invalid_master_cv`-style error rather than mutating the wrong
paragraph.

## Cover letters (`resumes.cover`)

A second producer and a second queue, because a letter must not wait behind a tailoring
backlog and must not wake a tailoring pod:

```json
{ "job_id": "0a58a065-...", "enqueued_at": "2026-09-26T21:10:00.000Z" }
```

| Field | Required | Notes |
|---|---|---|
| `job_id` | **yes** | the vacancy's row id; the letter is written from that row |
| `attempt` | no | informational; the authoritative counter is `resume_cover_letter.attempts` |

The payload carries **no** description and no CV: `cover.py` reads `resumes.description_raw` and
the master `cv_data.json` itself (invariant 24), so a stale copy cannot reach the prompt. The
outcome is one row of `resume_cover_letter` (`queued` -> `running` -> `completed`/`failed`) -
the broker semantics (ack / retry / TTL retry / DLQ) are the ones in the table below.

## Application drafts (`applications.draft`)

The extension's *Populate* button: published by `POST /api/apply/<job_id>`
(`backoffice/src/pages/api/apply/[jobId].ts`), consumed by `apply.py`.

```json
{
  "job_id": "53c558e4-...",
  "schema_hash": "9f2c...",
  "url": "https://djinni.co/jobs/746003-senior-nodejs-engineer/",
  "host": "djinni.co",
  "form": {
    "root": "form#apply_form",
    "html": "<form id=\"apply_form\">... <textarea data-cvt-id=\"f1\"></textarea> ...</form>",
    "fields": [
      {"id": "f1", "kind": "textarea", "label": "Which AWS services...", "name": "answer_161552",
       "placeholder": "", "required": true, "hidden": false, "options": []}
    ]
  }
}
```

* **The ids are minted by the extension** (`data-cvt-id`, f1..fN in DOM order) - the plan refers to
  them, so the model never returns a selector it cannot verify.
* **No documents travel**: the answer is a plan whose actions are `answer` / `select` /
  `cover_letter` / `resume_file` / `skip`, and the last two carry no value - the extension pastes
  the generated letter and the tailored PDF itself, from the board.
* **`schema_hash` is the cache key** (the rendered form + the candidate facts' version). The board
  claims `resume_application` and resets it to `queued` only when the hash differs, so a redelivery
  or a repeated *Populate* on the same form is acked as a duplicate without a second Gemini call
  (`apply.py::handle_delivery`), while a changed form is a genuine re-draft.
  `GET /api/apply/<job_id>?schema=<hash>` answers `completed` / `running` / `queued` / `failed` /
  `stale` / `none`, and the extension polls it while it waits.

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

Key: `coalesce(user_id,'local') : source : external_id : cv_version`, enforced by
`resumes_job_key_idx`. The site belongs in it: djinni's 848944 and DOU's 848944 are different
vacancies, and without the slug one would look like a duplicate of the other. A redelivered or
duplicated message therefore never pays for Gemini twice - the worker detects the completed
row, logs `already completed - acking duplicate` and acks.

## Local (directory) backend

With `QUEUE_BACKEND=directory` messages are JSON files:
`artifacts/queue/incoming/ → inflight/ → processed|failed|retry/`, and retries
bump `attempt` in the file itself. Same handler, same semantics, no broker.
