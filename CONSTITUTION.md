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
| Orchestration | LangGraph (`apps/worker/agent/graph.py`) |
| LLM (the only external call) | Google Gemini (`google-genai`) |
| Document surgery | `python-docx` (AST/XML mutation) |
| Rendering | LibreOffice (`soffice`) to poppler (`pdftoppm`) |
| Queue | RabbitMQ via `pika`, or JSON files |
| State | Postgres via `psycopg`, or a JSON file |
| Artifacts | A local directory / PersistentVolumeClaim (temp work under an `emptyDir`) |

Everything runs **on one machine, in a local Kubernetes cluster**. There is no
cloud account, no object storage and no managed database. The only outbound call
is to the Gemini API.

Chrome extension / scheduled scout --> board (one card per vacancy, "Scraped")
    the operator drags a card to "Prepare" (tailoring) or clicks Generate (letter / fill)
                                 |
                                 v
    RabbitMQ: resumes.generate . resumes.cover . resumes.rerender . applications.draft
                                 |   KEDA scales the queue's consumers 0 -> N -> 0
                                 v
    worker pods (prefetch = 1, one task per message)
      adapt_text -> render -> vision_check -> persist
                                 |
    cv-artifacts volume (DOCX/PDF) + Postgres (status, board, candidate facts)
```
Four queues, four consumers: `resumes.generate` -> `worker.py` (tailoring), `resumes.cover` ->
`cover.py`, `resumes.rerender` -> `rerender.py` (LibreOffice, no model), `applications.draft` ->
`apply.py`. The scout and the archiver are CronJobs that write board rows directly - no queue, no
model - and each records one row per run in `process_runs`. Queue topology and payloads:
`docs/ARCHITECTURE.md`; the runtime diagram: `docs/diagrams/`.

## 2. One way to run the pipeline

`apps/worker/agent/pipeline.py` is the **single** implementation of the flow, and there is a
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
entry points        apps/worker/worker.py · publisher.py · healthcheck.py
      |                     |
      v                     v
orchestration      apps/worker/agent/   (state, contracts, models, tailoring_prompt,
      |                      application_prompt, gemini, nodes, vision, persist,
      |                      graph, pipeline)
      |
      v
adapters/infra     apps/worker/utils/   (messaging, db, storage, model_state, retry, cv_text,
      |                      cv_replacements, docx_mutator, renderer, logging_setup)
      v
config             apps/worker/config.py   (env parsing only; imports no provider SDK)

deployment         infra/charts/ · infra/deploy/values/ · apps/worker/Dockerfile
operator tooling   scripts/ · Makefile
verification       apps/worker/tests/
documentation      docs/ · README.md
backoffice         apps/backoffice/  (Astro+React kanban UI + the authenticated batch gateway;
                                 shares the worker's Postgres)
scraper            apps/extension/   (Chrome MV3 scraper -> backoffice gateway -> queue)
scheduled jobs     apps/worker/scout/ · apps/worker/archiver/   (CronJobs on the worker's image;
                                 the scout's chart also runs it once per deploy as a Helm hook Job;
                                 each records its run in process_runs - `apps/worker/utils/process_runs.py` is the ledger)
automation         .github/workflows/
```

**Direction invariant:** `apps/worker/agent/` may import `apps/worker/utils/` and `config`; `apps/worker/utils/` must
**never** import `apps/worker/agent/`. `config.py` imports nothing from this project.

## 4. Invariants (do not break these silently)

The numbers are **stable addresses**: code, charts, SQL and the layer docs cite them
(`invariant 33`), so renumbering one means updating every reference. Append; never renumber.

1. **One pipeline.** `apps/worker/agent/pipeline.run_cv_tailoring()` / `run_task()` are the
   only ways to run the graph; `worker.py` calls them (and so do the tests).
2. **Ack only after `persist`.** The queue message is acknowledged after the
   artifact is stored *and* the DB row is written, so a crash/OOM/scale-down
   simply redelivers the message (`worker.handle_delivery`, `apps/worker/agent/nodes.persist`).
3. **Idempotency.** Business key `coalesce(user_id,'local') : external_id :
   cv_version`, enforced by the unique index `resumes_job_key_idx`. A duplicate
   delivery must never pay for Gemini twice.
4. **`job_id` is an opaque row id, not a business key.** Shape guard
   `[A-Za-z0-9_.:-]{4,80}` (anchored; Pydantic field plus the
   `resumes_job_id_shape` CHECK). A `job_id` that already belongs to another
   vacancy is refused (`outcome=owned`).
5. **The sync rule.** Every line of `cv_data.json` must exist **verbatim** in the
   master `cv.docx`; `validate_cv_data_against_docx()` enforces it and the task
   fails rather than mutating the wrong paragraph. Two properties are easy to
   forget: it is **one-directional** (it proves the JSON mirrors the DOCX, not that
   the DOCX is fully modelled - adding a section to `cv.docx` alone stays green and
   silently never reaches the prompt), and a line ending in `:` is a label, not data, so it
   is skipped.
6. **Replacements are single-line and marker-free.** `normalize_replacements()`
   splits concatenated label+value pairs, drops misaligned lines and no-ops, and
   strips leading bullet characters; `apply_text_replacements()` additionally
   skips any `original_text` containing a newline. A replacement may target **only
   three sections** - the header TITLE, the SUMMARY and the RELEVANT SKILLS: the
   PROFESSIONAL EXPERIENCE and PET PROJECTS blocks are read-only context, and
   `drop_read_only_replacements()` discards any replacement whose target is a line
   of either (invariant 30).
7. **No fabrication (hard rule).** The adaptation prompt may rephrase and
   re-weight only what is already on the CV - no invented employers, titles,
   dates, technologies or metrics. Two sources count as *already known*: the
   master CV text and the operator's candidate facts (invariant 31), which
   `apps/worker/agent/verification.py` accepts through `ground_truth=`; anything stated in
   neither is dropped. The **job description is not one of them** - it is the target
   (invariant 33) - and detection is vocabulary *plus shape*, so a name no list
   contains (`FastAPI`, `FastMCP`, `PyTorch`, `GPT-4`) is still checked.
8. **Fail fast on misconfiguration.** `worker.preflight()` checks storage, DB,
   render tools and `MODEL_NAME` (against `models.list()`) before consuming. A
   wrong model id is a non-retryable 400, so it must not reach a task.
9. **Headless means never-block.** Quota exhaustion raises `RetryLater` and the
   worker re-publishes to a TTL retry queue; only an interactive TTY may wait.
10. **Graceful shutdown.** SIGTERM sets `STOP_EVENT` and stops the consumer; the
    in-flight task finishes and is acked before the process exits.
11. **State is a flat, fully-populated TypedDict.** `initial_state()` fills every
    key so nodes may read without `KeyError`.
12. **Gemini calls are decorated.** Every call helper in `apps/worker/agent/gemini.py` (the
    only module that builds a client) goes through `retry_with_exponential_backoff`
    (429/503 backoff, model fallback ladder, daily-quota handling); the prompts
    live with their own layers (`apps/worker/agent/tailoring_prompt.py`, `apps/worker/agent/cover.py`,
    `apps/worker/agent/application.py`).
13. **Secrets never live in git.** `.env` is gitignored; charts use
    `existingSecret`; `scripts/worker-secret.ps1` creates the Secret.
14. **`helm lint`/`helm template` are not enough.** Render and validate with
    `kubeconform` before trusting a chart change (see section 5, D8).
15. **No public signup, ever.** Backoffice accounts exist only because an
    administrator provisioned them (`apps/backoffice/scripts/user.mjs`); the UI
    authenticates and never creates. A session is an HS256 token (cookie for the
    browser, `Authorization: Bearer` for the extension) signed with
    `BACKOFFICE_JWT_SECRET`, and `apps/backoffice/src/middleware.ts` is the only gate.
16. **The batch route validates and creates cards; the operator's drag publishes.**
    `POST /api/vacancies/batch` rejects anything the worker could not consume (required
    `external_id` + `description_raw`, http(s) `source_url`, a `[a-z0-9-]{2,32}` source slug,
    ≤ 25 cards) and then only creates `resumes` rows in the board's **Scraped** column -
    no broker round trip and no Gemini request. The message is published by
    `POST /api/board/move` when a card enters **Prepare**
    (`lib/board.ts::tailoringRequest` decides queue/retry/none), and it is exactly
    `ResumeTaskMessage`; the AMQP topology in `apps/backoffice/src/lib/queue.ts` mirrors
    `apps/worker/utils/messaging.py` field for field (a mismatch is a 406 from the broker).
17. **A scraped vacancy is a card immediately, and the worker's claim adopts it.** The
    intake (the batch route, and the scheduled scout) inserts the `resumes` row with
    `status = 'submitted'`; that row **is** the card, and it waits in Scraped until the
    operator drags it to Prepare. `submitted` must stay out of `ACTIVE_STATUSES`, otherwise
    the claim would ack the message as a duplicate and the card would never run; being
    non-active makes `_claim_row` re-claim that exact row. The board's *move* path still never
    writes `resumes.status`. **Its duplicate check is board-scoped, not account-scoped, and
    version-agnostic** (`findExistingVacancies(..., { scope: 'board', source })`, and the same rule
    in the scout's `find_existing_ids`: `cv_version` identifies a row, it does not make a vacancy
    new - filtering on it made a re-tailored card look new and created a `v1` twin, live
    2026-10-07): the board renders every row
    whatever its `user_id` (D11), so a check limited to the session account would offer to
    scrape a card the operator can already see - and the row it then created would look like a
    duplicate card. The business key includes `source`, so the same number on two sites is two
    vacancies. Rows created outside the board (the CLI `send-test-job.ps1`, the Helm smoke
    test) carry `user_id = NULL`, and every publisher queues with the *row's* `user_id` - a
    different owner would make the claim insert a second row. That is how this was found live
    on 2026-09-26.
18. **`resumes.pdf_url` / `docx_path` are storage paths, not URLs.** They are what
    `apps/worker/utils/storage.LocalStorage.upload` returned
    (`/data/output/artemmuntianu-848944.pdf` in the cluster), so nothing in a browser may link them:
    the board serves downloads from
    `GET /api/artifacts/<job_id>` (keyed by `job_id`, resolved against `ARTIFACTS_DIR`,
    traversal-refused) and reports "not on this machine" instead of a bare 404. **Both
    documents are served** (`?format=docx` included - the mirror used to copy only PDFs),
    and `fetchBoard` reports per-card `artifactAvailability`, so the UI labels an
    unmirrored document instead of offering a link that cannot resolve.
    The name is `<candidate>-<vacancy>` since 2026-10-08: the stem comes from the `full_name`
    candidate fact through `storage.artifact_stem`, which keeps lower-case ASCII alphanumerics only -
    the board echoes the file name in a hand-built `content-disposition` header and Node refuses a
    non-latin-1 one - and a card with no owner, no facts row or no name keeps the bare vacancy id, so
    nothing already on the volume needed renaming.
    On a dev machine the board can also point straight at the volume: Docker Desktop keeps
    its PVs on the VM disk, which Windows reaches through WSL
    (`\\wsl$\<distro>\mnt\docker-desktop-disk\data\k8s-pvs\<pvc>\output`) -
    `scripts/storage-files.ps1 -Action path` prints that `OUTPUT_DIR`. `isWorkerVolumeRoot`
    recognises the root, so removing a vacancy deletes the worker's file instead of queueing
    it for the volume sweep.
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
    **The vocabulary is the catalogue, and an edit is catalogue-only.** `board_actions` is
    the whole list (`apps/backoffice/src/lib/db.ts::fetchActionVocabulary` reads nothing else), so
    a removed or reworded value stops being suggested in a dialog and stops being offered as
    a filter option - there is no second, history-derived half. The words themselves are not
    touched: `resume_history` and `archived_reason` keep what they were recorded with, and
    the card's own History section still shows them (invariant 19).
22. **Removal is a purge, and it is the only irreversible action.** `POST /api/board/remove`
    requires an **archived** card whose status is terminal (`REMOVABLE_STATUSES`) - a
    vacancy a worker still owns is refused, because the task that finishes after the purge
    would leave artifacts behind with nothing pointing at them. It deletes the artifact
    files the board can reach, queues every stored path it cannot in `artifact_purge`
    (`scripts/storage-files.ps1 -Action purge` sweeps the volume and clears the rows), and
    last deletes the `resumes` row - taking `resume_board`, the whole `resume_history` and
    the refusal record with it, because both cascade. **Nothing is tombstoned**: the vacancy
    becomes unknown again, so re-scraping its page creates a fresh card and pays for
    tailoring again.
23. **Tailoring is operator-triggered, and a failed request is rolled back.** Scraping - the
    browser extension or a scheduled scout - never spends Gemini: cards land in Scraped and
    stay there until the operator drags one into Prepare (`lib/board.ts::tailoringRequest`).
    That request publishes first and moves second, and if the broker refuses, a card that just
    left Scraped is moved back with the reason recorded in `resume_history` - so "in Prepare"
    can never quietly mean "no message was ever sent". A card whose stored `description_raw`
    is null (scraped before 2026-09-26) is refused with 409 and stays where it is rather than
    poisoning the DLQ, and a parked card already in Prepare is *retried* by the same request
    without a stage change. The move may also carry a **company the scrape left empty** (the
    dialog's *Missing fields* section): `resumes.company` is the one worker column the board
    writes, and only into a blank - the site's value always wins
    (`lib/missing.ts::resolveCompany`), and it is written *before* the task is built, because both
    the tailoring prompt and the cover letter read it and would otherwise say "unknown company".
    Like the card's detail fields it is not historicised (invariant 28).

24. **Cover letters are on demand, on their own queue.** A letter is application material,
    not a stage of the funnel: the board offers *Generate* on **any** card, whatever its column
    and whether it is archived (`POST /api/cover/<job_id>`). It goes to `resumes.cover`, which
    has its own worker (`cover.py`), its own DLX/DLQ and its own ScaledObject, so asking for a
    letter can never wake a tailoring pod - and the four declarers of that topology (the chart's
    definitions, `apps/worker/utils/messaging.py`, `apps/backoffice/src/lib/queue.ts`) have to agree as exactly
    as they do for `resumes.generate`. The prompt is built from **the database's own copy** of
    the job description (`resumes.description_raw`) and the master `cv_data.json`, never from a
    copy in the message, and it forbids inventing anything the CV does not say - so the feature
    is useless on a card scraped before 2026-09-26, and the API refuses such a request with 409
    (the worker would dead-letter it). The result is one row in `resume_cover_letter`, which the
    board reads through the card payload; `queued` means "asked for", which is what makes a
    regeneration a genuine request and a redelivery a duplicate. A letter is asked for in two
    ways: the card's *Generate* (always a fresh one - that is what a click means) and **a move
    into Prepare**, which requests it beside the tailoring. `lib/coverRequest.ts` is the one
    implementation both callers use; the automatic one is best effort (a cover failure never
    rolls the move back, it is reported in the move's answer instead) and it leaves a letter that
    is already written or on its way alone (`lib/cover.ts::coverNeeded`), because regenerating
    behind the operator's back would replace text they may have read and pay for a second call.

25. **The scheduled intake creates cards and nothing else.** `python -m scout` (`apps/worker/scout/`)
    fetches the configured feeds, de-duplicates against the **board** (`find_existing_ids`: any
    owner, any status - invariant 17), inserts one `resumes` row per new vacancy with
    `status = 'submitted'`, and sends one Telegram message per card. It calls no model, publishes
    no message and owns no status beyond that intake value, so a run costs nothing no matter how
    many vacancies it finds - which is also why there is no per-run limit by default
    (`SCOUT_MAX_PER_RUN=0`). `SCOUT_USER_ID` must be a provisioned `app_users.id` - and
    specifically the **operator's**, not a separate service account: every prompt is grounded in
    the candidate facts of the card's *owner* (`candidate_module.load(store, row.user_id)`), so
    filing scouted cards under their own account grounds them in that account's facts. That is the
    2026-10-03 `Ukraine` bug (Djinni 851326; `scripts/reown_scout_cards.sql`), and it fits "the
    board renders every row whatever its `user_id`". The drag publishes the **row's own** owner, so
    a different one would also make the claim insert a second row. "No feed answered" exits 1: that
    is not an empty week, and a CronJob has to be
    able to tell them apart. The declared queue `vacancies.parse` stays unused - the scout parses
    in-process (D12). Its chart sets `startingDeadlineSeconds` (86400), so a slot missed while the
    cluster was down runs as soon as it is back - the run is idempotent, so a late run is harmless.

    **A card's site is a property of its feed, not of the run.** There is no `SCOUT_SOURCE`: one
    module per site in `apps/worker/scout/parsers/` exports a `FeedSource` (slug, hosts, pure parser), the
    registry (`apps/worker/scout/sources.py`) routes every fetched URL by **host**, and the slug it decides is
    what completes the business key (`resumes_job_key_idx`) - deliberately the same slug the
    browser scrape derives from its page URL (`apps/extension/src/sites/index.js::siteForUrl` - one
    plugin per site, invariant 35,
    invariant 16), so a vacancy the intake found and the same vacancy scraped by hand are one card.
    A feed no parser claims fails preflight (`collect` skips it) instead of being guessed at, and
    the suite requires a fixture for every discovered source and a parser for every configured feed
    URL - so adding a site is a parser module plus a URL in `SCOUT_FEEDS`, not an edit to the flow.
    DOU, Djinni and Landing.Jobs are the three that exist today: a DOU title carries
    role/company/location plus a salary tail, a Djinni title carries the role alone (its feed has no
    company, salary or location, so those card fields stay empty rather than being guessed), and
    Landing.Jobs publishes **Atom** - one document holding its whole open board, ISO-8601 dates, the
    company in `<author>` instead of the title, and its own `lj:` elements whose namespace the feed
    never binds (the parser repairs that; `apps/worker/scout/AGENTS.md`).

    The intake also **refuses what a feed dated too long ago**: a date older than
    `SCOUT_MAX_AGE_DAYS` (14 days, `0` disables the rule) means no card, no dedupe check and no
    Telegram message, because a feed is a window and not a stream. The feed's own date is read in
    either form a feed uses - RFC-822 on the two RSS boards, ISO-8601 on the Atom one - and a vacancy
    whose feed states no usable date is kept: the rule judges what a feed said, never what it omitted,
    so a feed that stops publishing dates cannot become a silent no-op (`apps/worker/scout/policy.py`).

26. **Interviews are their own record, and every write to them is operator activity.**
    `resume_interview` (one row per call: `scheduled_at`, `type` - the four types are code plus
    a DB CHECK - and the free-text `result`) keeps the interview itself, and the `result` is stored
    there and nowhere else. On top of that, each of the three writes from the Interviews section -
    add, edit, remove - leaves **one** `resume_history` line (`kind='move'` with
    `from_state = to_state`, the column the card is in) and bumps `resume_board.updated_at`, through
    the same `apps/backoffice/src/lib/db.ts::recordCardActivity` the *Add action* button uses: a card
    whose interview was just scheduled or corrected has to read as touched. (Revised 2026-10-01:
    the write path used to keep neither, and the card's *Last change* plus its "updated N days ago"
    label read `resumes.updated_at` - the worker's column - so a fresh interview looked days old on
    `brightfin/373897`.) What *was* already audited is the move into **Interviewing**
    (`kind='move'`, the action text the operator chose), and that is also what makes the section
    appear (`apps/backoffice/src/lib/interviews.ts::hasReachedInterviewing`: the history has such a move,
    or the card is in the column now) - so a card that moved on to Offer keeps its interviews and a
    card that never got there has no section. The first interview can be collected by the Move
    dialog and is inserted *in the same transaction* as the column change; that drop writes its move
    line, so the interview it seeds adds no second one, and an empty draft inserts nothing. Rows
    cascade away with the card (`🗑 Remove`).
27. **The board's columns have a second, headless writer: the scheduled sweep.** `python -m
    archiver` (`apps/worker/archiver/`, a daily CronJob) refuses the cards in `AUTO_ARCHIVE_STAGES`
    (`applied`) whose **`resume_board.updated_at`** - the board's own activity clock, bumped by
    every move, archive, restore and recorded action - is older than `AUTO_ARCHIVE_AFTER_DAYS`
    (`10`) days. It keeps the archive invariants exactly (19, 20): the three archive columns
    together, one `kind='archive'` history row, one `board_actions` upsert, all in one
    transaction per card; it never moves a card, never writes `resumes.status`, never queues a
    message, never calls a model and never deletes anything (`resumes.updated_at` is
    deliberately *not* the clock: the worker's status writes are not operator activity). The
    workaround for a card that must stay is the card's **`➕ Add action`** button, which records
    an action without moving it (`POST /api/board/action`: a `move` history row with
    `from_state = to_state`, no queue message - so it is not the Prepare *retry* a same-column
    move would be). Both scheduled jobs open one row per run in **`process_runs`**
    (`apps/worker/utils/process_runs.py`: `feed-parser`, `auto-archiver`), which is what the board's
    **Processes** window reads - a run that changed nothing is visible, a killed run stays
    `running` until the next run of that job retires it as `aborted`, and a `--dry-run` writes
    no row at all. A row also says *what* started the run - the column's CHECK is
    `schedule | manual | startup` - and the intake is the one job that uses the third: its
    chart (`infra/charts/cv-tailoring-scout`) posts the same Job once as a Helm
    `post-install,post-upgrade` hook (`python -m scout --trigger startup`), so a deploy runs
    the intake instead of waiting up to half an hour for a slot, and a startup run that fails
    fails the release (the run is idempotent, so the next deploy or slot is free to try
    again). CronJob slots are the timer besides that hook; `startingDeadlineSeconds` is what
    makes a slot missed while the cluster was down run as soon as it is back.

28. **The card's detail fields are board state, and editing one is activity.** The
    `recruiter`, `salary_offered`, `salary_desired`, `communication_channels` and `apply_url`
    columns on `resume_board` are the operator's own notes on a vacancy: free text with a
    200-character cap, the channels one of six values (`Email`, `LinkedIn`, `WhatsApp`,
    `Telegram`, `Dou`, `Djinni` - a DB CHECK, i.e. code + constraint like the Actors and the
    interview types, never an admin-editable catalogue), and the application URL an http(s) URL
    capped at 1000 characters. The card's **Details** form writes all five in one
    `POST /api/board/details`, an emptied input clears the field (the row stores NULL, never `''`),
    and the write bumps `resume_board.updated_at` - which is the point: typing a recruiter is
    operator activity, so the date window surfaces the card and the inactivity sweep (invariant 27)
    leaves it alone for another ten days. It writes **no** `resume_history` row, exactly like an
    interview edit (invariant 26): these are card attributes, not funnel transitions, and History
    is where the moves live.

    `apply_url` is the newest of them and the only one that is *not* free text: it is **where the
    Apply button actually lands** when that is not the posting itself - a DOU or Djinni card whose
    Apply opens the employer's own ATS page (`job-boards.eu.greenhouse.io/growe/jobs/4987494101`).
    It lives on `resume_board` rather than `resumes` on purpose: only the click reveals the
    redirect, so it is operator data, not something a scrape can know. Both sides go through
    `apps/backoffice/src/lib/applyUrl.ts::normalizeApplyUrl` - written by the Details form, read by
    `GET /api/vacancies/link` - which drops the fragment and the **tracking** parameters
    (`?gh_src=…`, `?utm_…`; not part of the vacancy's identity) while **keeping** the rest of the
    query: on a board that renders every posting at one path the query *is* the vacancy
    (Greenhouse's `?gh_jid=…`), so dropping it wholesale made the stored URL a dead link *and*
    ambiguous between two postings (fixed 2026-10-08). The host is lower-cased, so a stored URL
    can actually match the page it came from. The DB CHECK (`resume_board_details_shape`) admits
    only `http(s)://…`,
    and the constraint is **widened guard-first** in `SCHEMA_SQL`: it is created `if not exists`,
    so a database that already had the four-field version is rebuilt rather than silently left
    unguarded (`apps/worker/tests/test_postgres_store.py::test_the_details_constraint_is_widened_for_the_application_url`).

29. **The audit trail is correctable by hand, and correcting it is not activity.** A
    `resume_history` line is written by a dialog or a job; the board's **History** section lets the
    operator rewrite one (`PATCH /api/board/history/<id>`: date, actor, wording, kind and both
    states) or drop one (`DELETE`), because a mis-recorded line - a wrong actor, a date nobody had
    to hand, "Other" where the reason mattered - is worse than a corrected one. The vocabulary is
    still the DB CHECKs (four kinds, `Candidate`/`Company`, a 500-character reason), and the two
    states are validated **against the kind** in `apps/backoffice/src/lib/history.ts` (a `move` carries
    column ids, a `tailoring` line the worker's sub-states, `archive`/`restore` the pair
    `active`/`archived`): that is the one check the table cannot make, so it is made in code before
    the database is touched. A correction writes `resume_history` and **nothing else** - no column
    change, no `resume_board.updated_at` bump (so it cannot buy a card out of the inactivity sweep
    of invariant 27), no `board_actions` upsert (fixing what a line says is not a new action name)
    and no second history row: `resume_history` has no `updated_at`, so a corrected line is
    deliberately untraceable as such, which is why the dialog spells out what it does. The one
    consequence outside History is the **Interviews** section, which is shown on the strength of a
    `move` into Interviewing (invariant 26): dropping that line hides the section while the card's
    `resume_interview` rows stay where they are. The `/admin` vocabulary surface still never
    rewrites history - only the operator's own pencil does.

30. **PROFESSIONAL EXPERIENCE and `personal_projects` are read-only context.** Only three sections
    are tailored - the header TITLE, the SUMMARY and the RELEVANT SKILLS (invariant 6). The
    **experience** block (`utils.cv_text.experience_lines`) and the **projects** block - the
    document's own **PET PROJECTS** heading, the JSON key keeps the model's name - are rendered
    into the CV text (`utils.cv_text.project_lines`) so the model can draw on them: a project stack
    is *proof* of a technology, and `apps/worker/agent/verification.py` admits those terms. They may
    inform the SUMMARY and RELEVANT SKILLS **only**: `drop_read_only_replacements()` discards any
    replacement whose target is one of their lines - the experience wording, dates and metrics must
    survive the run, and a project's title/year row carries the entry layout while the
    `Website:`/`Repo:`/`YT Video` lines carry the URLs. Every project `title`, `year` and `stack` is
    stored verbatim (one field per DOCX paragraph) because invariant 5 is a per-line substring test.

    The master CV was refactored on 2026-10-06 into the shape this invariant describes: two
    top-level tables (a profile table and a two-column roles/projects table), where every entry is
    a `content | meta` row pair - role + context on the left, period + employer on the right - followed by
    a merged body row (`Key Highlights:` / `Responsibilities:` / `Tech Stack:`). The earlier
    layout kept the whole page in one table-in-a-table and right-aligned the project years with
    tab runs; there are no tab runs left in the document.

31. **One candidate-facts document grounds every prompt.** `application_profile` (one jsonb row per
    operator; `apps/worker/utils/candidate.py`, mirrored by `apps/backoffice/src/lib/candidate.ts`) is the half of
    the candidate that a CV does not carry. The CV tailoring prompt, the cover letter and the form
    prompt all receive the same rendered digest, and `apps/worker/agent/verification.py` accepts it as an
    admissible source (`ground_truth=`) so a fact-backed technology or number is not dropped as a
    fabrication. It is **evidence, never document text**: no prompt may write contacts, salary,
    availability, work format, location or job-search status into the CV or the letter. Facts cap at
    `MAX_VALUE_CHARS`, standing answers at `MAX_ANSWER_CHARS` (a project deep-dive does not fit in a
    form field); `scripts/seed_profile.py` loads a whole answer set, and `PUT /api/profile` keeps
    `standing_answers` while the key is absent (a partial save cannot wipe the question/answer set)
    but replaces it key for key when a caller sends the whole set - which is what lets the `/sources`
    answers editor remove or reword a question. The row that grounds a card is its **owner's**
    (invariant 25), and the extension no longer edits facts at all: the one maintenance surface is
    this row (`/sources` renders it and edits it through `CandidateFactsEditor` - the short facts -
    and `StandingAnswersEditor`, a `json-edit-react` tree over the recruiter Q&A set;
    `seed_profile.py` loads a whole answer set into it).

32. **The deliverable can be replaced by hand, and the PDF follows.** The operator downloads the
    tailored DOCX, verifies it, edits what the model could not, and uploads it back through the
    card modal (`POST /api/board/docx/<job_id>`, the *Update docx* button - offered only for a card
    that has a `docx_path`, refused with 409 otherwise). Its own queue (`resumes.rerender`, its own
    worker `rerender.py`, its own DLX/DLQ/ScaledObject and the same four-declarer agreement) renders
    the upload with the image's LibreOffice and repoints `resumes.docx_path`/`pdf_url` **in place**,
    so the board's existing artifact links are the new pair with no new concept. The bytes travel in
    Postgres (`resume_docx_update.content`): the POC board runs outside the cluster and cannot write
    the `cv-artifacts` volume, which is the same reason it *reads* artifacts through the mirror. One
    row per vacancy is the audit trail (`queued` -> `running` -> `completed`/`failed`), the claim
    refuses while a render is `running` (two clicks cannot replace the bytes a conversion is
    reading), `MAX_DOCX_UPLOAD_BYTES` is enforced on both ends, and a card that never went through
    tailoring is refused by the route *and* dead-lettered by the worker.

33. **The job description is a target, never evidence.** Nothing a vacancy asks for authorises a
    claim about the candidate (invariants 7, 31). The tailoring answer is checked by
    `apps/worker/agent/verification.py::invented_technologies` against those two sources only - the JD is passed
    in for diagnostics ("the vacancy asks for it, which is a reason to leave it out"), never as
    evidence - and detection runs on a curated vocabulary *plus* the shape of a name (an internal
    capital like `FastAPI`/`FastMCP`/`PyTorch`, or a digit like `GPT-4`/`n8n`), because no list can
    contain tomorrow's tool. Three layers enforce it: the prompt states the rule (tailoring rule 12),
    `self_heal_replacements` hands a violating answer back with the violations spelled out up to
    `MAX_FABRICATION_RETRIES` (3) times and keeps the best draft it saw, and whatever is still
    offending is *dropped* - the CV keeps its own wording, so nothing unbacked reaches the file. The
    guarantee covers the file too: the `verify_document` node (`apps/worker/agent/document_gate.py`) reads the
    produced DOCX back and **fails the task** rather than upload a CV whose text claims something no
    evidence backs. It runs **before the visual check** - straight after `adapt_text`, ahead of
    `render`/`vision_check` - so a lying document costs nothing to reject and never occupies the
    renderer or the vision model, and each pass of the vision retry loop re-verifies because the
    loop comes back through `adapt_text`. 2026-10-01 is why all of it exists:
    `FastAPI` and `FastMCP` shipped in a tailored CV for `851224` because the job description was one
    of the admissible sources and neither token was in the pattern the check searched for.

34. **A site the feed intake cannot reach is browser-scraped only, and one of them is not a list.**
    The registry (`apps/extension/src/sites/index.js`, invariant 35) is what derives `resumes.source`
    from the page's own host, and that is what keeps a browser scrape and a scouted card on one row (`resumes_job_key_idx`,
    invariants 16/17/25). Five slugs exist today - `djinni`, `dou`, `greenhouse`, `indeed`, and
    `teamtailor`. The last is the **filler's alone**: an employer's own ATS page reached from a card's
    Application URL, where `JOB_PAGE` answers *no vacancies* rather than a mangled card and the host is
    granted for `src/formfill.js` (2026-10-07, card `353314` - before the grant, Populate answered
    "no form filler on it"; a second customer host, `career.avenga.com`, was claimed the same way on
    2026-10-08). Meanwhile `indeed` **only the browser can
    produce**: Indeed serves no feed and no API. Verified
    2026-10-05: `pt.indeed.com/rss` returns no feed and `robots.txt` disallows `/rss` and `/*?rss`
    for `User-agent: *`; the old Publisher Job Search API host `api.indeed.com` no longer resolves;
    and every HTML path - the homepage, `/jobs`, `/viewjob` - answers 403/401 to a client that is
    not a browser. So there is deliberately **no `scout` parser for it**, and nothing unattended may
    touch it: the extension is the operator's own session, one page at a time. Its shape is also the
    one exception to "a card is a vacancy": Indeed's feed is a card list *plus* a pane, and **exactly
    one description exists on the page at a time** (the selected card's), so `extractVacancies`
    returns that single *selected* vacancy (`mode: 'indeed-pane'`) and `src/indeed.js` is what
    selects a card and waits for the pane - "ready" being *both* the pane's own `fromjk` naming that
    job *and* its description having rendered, because the highlight and the pane's links move before
    the text does (a 3 s wait on the highlight alone handed the worker an empty pane, which surfaced
    as "that card is not on this page any more", live, 2026-10-05). A pane-less Indeed page therefore
    yields **nothing** rather than twelve snippet-only cards: a snippet is not a job description, and
    filing one would tailor a CV against marketing copy. The popup's **Scrape & queue this page** is
    therefore a *walk* on Indeed (`apps/extension/src/indeed/sweep.js`, driven by the worker because a
    popup cannot hold a thirty-second loop): it selects each card the page has rendered, reads that
    card's own pane, and publishes the lot in batches of 25 - skipping, and counting, any card whose
    description never rendered. One slug covers every country site on
    purpose - Indeed's `jk` is unique across them, so `pt`/`www`/`uk` are one id space.

35. **A site is a plugin, and one registry names them.** Every scraped site is one module in
    `apps/extension/src/sites/` binding a slug (`resumes.source`), the hosts it owns, the content-script
    behaviour it needs, and the **strategy** its pages are read with; `sites/index.js` routes a URL by
    host (`siteForUrl`, or the lenient `siteForPage` with its `other` fallback) and `validate()` refuses a
    duplicated slug or host at load. Nothing else in the extension names a site - `background.js`,
    `popup.js` and `indeed/sweep.js` all ask the registry, which mirrors
    `apps/worker/scout/sources.py` (one module per site, routed by host, validated at load) deliberately.
    One exception exists, and it is read-only: the MyGreenhouse portal's **badge** script
    (`apps/extension/src/mygreenhouse.js`) asks its status question with an explicit `source`
    (`'greenhouse'`). `my.greenhouse.io` lists that slug's vacancies while deliberately not being a
    host the `greenhouse` plugin claims, so a host-derived answer would be `other` and every badge
    grey whatever the board held (2026-10-08). `cardStatus` honours a message's own `source` over the
    tab's, the constant is pinned to the registry by `mygreenhouse.test.ts` (`siteForSlug`), and the
    script scrapes nothing.
    The strategy is **data, not code**, and that is a constraint rather than a preference:
    `chrome.scripting.executeScript({ func })` serialises the injected function's *source*, so a reader
    cannot close over a module, and `args` are structured-cloned, so a function cannot be passed either.
    One executor (`apps/extension/src/extract.js`, which is why its DOM toolkit lives inside that
    function) interprets the three kinds - `cards`, `job-page`, `pane` - so a new **shape** is a new
    reader there, while a new **site** on a known shape is a binding and nothing else. The manifest's
    host wiring and the board's own slug labels (`apps/backoffice/src/lib/cardMeta.ts`) cannot be derived
    from the registry - neither file can import it - so `sites.test.ts` pins both against it in both
    directions.

36. **The extension fills application forms, and it never submits them.** The second half of
    `apps/extension/` (`src/formfill.js`, `src/form/`) puts the operator's *Populate* click through one
    round trip: the page annotates every fillable control inside a **picked** form root with a
    deterministic `data-cvt-id`, the board queues that snapshot on `applications.draft`
    (`apply.py`, its own ScaledObject), and the plan comes back keyed by those ids. Two rules are
    the point of the design. First, **the generated documents never travel**: the model is asked
    *which element* the cover letter and the tailored PDF belong in (`cover_letter` /
    `resume_file`, always with an empty value) and the extension inserts both itself, from
    `GET /api/cover/<job_id>` and `GET /api/artifacts/<job_id>`. Second, **a missing fact is
    skipped, never invented**: the prompt may use the vacancy, the CV digest and the candidate
    facts (`application_profile`, one jsonb row per operator, because the board edits it on the
    host while the worker reads it in the cluster), and everything else comes back as
    `skip` + a reason for the review panel. The snapshot's hash is the cache key, so re-filling the
    same rendered form costs no Gemini call while a changed form re-drafts; the extension never
    clicks submit, a consent checkbox or a site preference control, and never touches a
    `hidden`/`password`/disabled field. **Which card a page belongs to is resolved twice, and
    never guessed**: the page's own vacancy id first (`GET /api/vacancies/status`, the lookup the
    injected buttons use), and when that finds nothing, the page URL against the cards' own
    application URLs (`GET /api/vacancies/link`, invariant 28's `apply_url`) - the only way to
    reach a card scraped on Djinni/DOU whose Apply button opened the employer's form. Neither
    match stops the flow with "this page is not linked to a card yet" instead of filling a form
    from the wrong vacancy. **Which part of a page's URL is the id is the site's own business**
    (`apps/extension/src/sites/<site>.js`'s `urlId`, read by `sites/index.js::vacancyIdFromUrl`):
    Djinni writes it after `/jobs/`, DOU after `/vacancies/`. The flow used to hard-code `/jobs/`,
    so every DOU page answered "no id" and fell through to the application-URL lookup - card
    `375802` was unfillable from its own DOU page on 2026-10-07, and the two `jobs.dou.ua` rows in
    `resume_board.apply_url` are the workaround that forced. The field is therefore **optional for a
    card whose own posting is the page being filled**, and needed only when the Apply click leaves
    the site.

37. **The repo is LF-only.** `.gitattributes` (`* text=auto eol=lf`) stores *and*
    checks out every text file with LF - it overrides a system-level
    `core.autocrlf=true`, which had rewritten 276 tracked files to CRLF and made
    exact-match edits silently miss. After changing line-ending attributes,
    renormalise with `git add --renormalize .` then `git checkout-index -f -a`.

## 5. Known discrepancies, dead code and legacy paths

These were verified against the working tree on 2026-09-19. They are **not**
invitations to "fix" blindly - they are recorded so nobody rediscovers them, and
so that a change which depends on them is a conscious one.

| # | What | Reality | Status |
|---|---|---|---|
| D1 | `Dockerfile` line 48 comment ("persist to Supabase") and line 51 `ENV STORAGE_BACKEND=supabase` | There is no `STORAGE_BACKEND` in `config.py`, and `apps/worker/utils/storage.py` has no backend selection - storage is unconditionally `LocalStorage`. `infra/deploy/values/dev.yaml` (`config.storageBackend: local`) and `.github/workflows/helm-smoke.yml` (`--set config.storageBackend=local`) set a value that `infra/charts/cv-tailoring-worker/templates/configmap.yaml` never renders, so both are inert as well | **Dead** (leftover from the removed Supabase era). Harmless at runtime, misleading to readers. |
| D2 | `pyproject.toml` description named Supabase | Supabase was removed; storage is a PVC | **Fixed 2026-09-25** |
| D3, D9 | Unused leftovers: `pypdf` in `requirements.txt` (never imported) and the Supabase keys the gitignored `.env` may still hold | Neither is read | **Dead** |
| D4, D5 | Unused config: `config.RABBITMQ_MANAGEMENT_URL` (KEDA reaches the management API through the broker Secret's `rabbitmq-management-url`) and `config.QUEUE_RETRY_TTL_MS` / the chart's `config.queueRetryTtlMs` (`messaging.py` uses the hard-coded `RETRY_LADDER_SECONDS`) | Never read by application code, so the chart knob is **inert** | **Unused config** |
| D6 | `apps/worker/utils/renderer.convert_docx_to_pdf` fallback `from docx2pdf import convert` | `docx2pdf` is not in `requirements*.txt`; Windows-only, unexercised | **Untested fallback** |
| D7, D8 | Test counts and the "image never built / `helm install` never ran" claims in `docs/PROJECT_STATE.md` | It is a point-in-time session handoff, not live status: its counts are stale and nothing in it may be read as current | **Stale doc** |
| D10 | `docs/postgres_schema.sql` vs `apps/worker/utils/db.SCHEMA_SQL` | **Resolved 2026-09-25**: the `.sql` file existed only for the removed docker-compose initdb path and is deleted, so `SCHEMA_SQL` - what the worker executes on startup, and therefore what exists in the cluster - is the single source of truth | **Resolved** |
| D11 | `apps/backoffice/` (the kanban POC) | Shares the worker's Postgres: it reads `resumes` and owns `resume_board` + `resume_history` + `app_users` (all in `SCHEMA_SQL`, the vacancy-linked ones `on delete cascade`), one transaction per manual move (`actor` + reason recorded). It never writes `resumes.status` - the `created` sub-state is derived from it. Authentication: admin-provisioned accounts, HS256 session cookie or bearer token, no signup route. Its batch gateway *creates* the card (`resumes` row, `status='submitted'`) before publishing, so a scraped vacancy is on the board at once (invariant 17), its `GET /api/vacancies/status?external_ids=...` answers "already on the board?" for the extension's injected per-card buttons (the same lookup, board-scoped), and its artifact links are served by the board (`GET /api/artifacts/<job_id>`) because the stored values are paths on the `cv-artifacts` volume (invariant 18). Refusals are an in-place soft delete with an audited reason (invariant 19) and the Action vocabulary lives in `board_actions` (invariant 20); the top bar's Filters panel is where archived cards, columns and actions are selected. **Roles are enforced for the vocabulary admin surface only** (`/admin` + `/api/admin/*` need the `is_admin` claim, invariant 21) - the board itself is still all-users, and the remaining `app_users` management is the CLI. A refused card can also be **removed for good** (invariant 22): the row, its board state, its whole history and its artifacts - with whatever the board cannot reach queued in `artifact_purge` for `scripts/storage-files.ps1 -Action purge` | **POC gap** - still not deployed in-cluster; run it locally against `kubectl port-forward svc/postgres 5432:5432` (and `svc/rabbitmq 5672:5672` for the batch endpoint) |
| D12 | The source design's Supabase + Vercel hop | Both providers are out (`Supabase` = legacy, `Vercel` = never part of the local runtime), so their *functions* were implemented locally instead: **auth** = `app_users` + `apps/backoffice/src/lib/auth.ts` + `scripts/user.mjs` (manual provisioning, no signup); **storage** = the `cv-artifacts` PVC (`apps/worker/utils/storage.py`); **API gateway** = `POST /api/vacancies/batch`; **realtime push** = the board's 5s live poll (`App.tsx`), not WebSockets. `applications.submit` has no producer yet and `vacancies.parse` has no consumer (parsing is client-side in `apps/extension/`, and `apps/worker/scout/` parses in-process rather than through that queue) | **Substituted by design** - do not reintroduce the providers; `apps/extension/` is the real replacement for the design's "Chrome extension" box (it scrapes before the gateway; and its loading `content_scripts` entry injects a `Scrape`/`Scraped` button into every listing card, the `Scraped` link deep-linking to `/?card=<job_id>` on the board) |
| D13 | `scripts/archive_not_applicable.sql` (described as the 2026-09-26 spreadsheet import's written record) | The file does not and never did exist; the import it documented is real, and the *fresh* `updated_at` it left on nine `applied` cards (which made the sweep report `candidates: 0` every morning) was repaired by `scripts/backdate_imported_clocks.sql` | **Doc fixed 2026-09-27** |
| D14 | `SCHEMA_SQL` created `application_profile` (which references `app_users`) **before** `app_users` | A *fresh* database died at `relation "app_users" does not exist`, invisible while every database already carried the account table; the gated fixture's stale drop list hid it too | **Fixed 2026-09-29** - `app_users` is created first and the fixture drops all 13 tables |
| D15 | Fonts in the container: the rendered PDF vs what Word shows | Carlito is metric-compatible with Calibri, so the **body** wraps and paginates exactly as Word does; it has no *Light* weight, so the master CV's Calibri-Light headings rendered in **DejaVu Serif** - a different design *and* different metrics. Verified 2026-09-29 by `pdffonts` on `artifacts/input/cv.docx` inside the worker image, A/B against that image with the Calibri layer hidden (`fc-match 'Calibri Light'` **alone** reports DejaVu *Sans*, which is not the face the render picks - never treat it as the evidence); `Times New Roman` appears only as theme fallbacks, and no serif substitute reaches the PDF | **Mitigated 2026-09-29** - `scripts/fetch-fonts.ps1` copies the licensed Calibri family from Windows into the untracked `apps/worker/fonts/`, which `docker build` installs + `fc-cache -f`; CI builds the same Dockerfile with that directory empty and keeps the substitution on purpose. Microsoft-licensed: never committed, never published |
| D16 | `candidate_profile.json`, named in the code and the extension popup (until 2026-10-03) | There is no such file: the facts are the `application_profile` **row** (`utils/candidate.py`, mirrored by `apps/backoffice/src/lib/candidate.ts`), and a row is deliberate - the board edits it on the host while the workers read it in the cluster. `artifacts/candidate_profile.json` is only the *seed input* of `scripts/seed_profile.py` | **Doc fixed 2026-09-29** |

### Legacy / removed (do not reintroduce)

* **Supabase Storage** - replaced by the `cv-artifacts` PVC plus `utils.storage.LocalStorage`.
* **Azure / AKS / ACR / Bicep** and the cloud deploy workflow - deleted in favour of local-first.
* **Bitnami RabbitMQ subchart** - replaced by our own StatefulSet on the official
  `rabbitmq:3.13-management` image (the Bitnami index moved behind
  `repo.broadcom.com` and its free images were emptied; see
  `infra/charts/cv-tailoring-platform/Chart.yaml`).
* **Every second way to run the app** - removed 2026-09-25 in favour of the single
  local-cluster runtime: the batch CLI (`main.py`), `docker-compose.yml`, the
  managed-cluster documentation and `docs/postgres_schema.sql` (D10). Publishing from
  the host is `scripts/send-test-job.ps1` → `publisher.py`; the batch *CLI* entry point
  is gone for good - do not add another one. (The HTTP batch endpoint in the backoffice
  is a different thing: it is a gateway, not a second runtime - see D12.)
* **Supabase (Auth, DB, Storage, Realtime) and Vercel.** Their *functions* now live in
  the local stack - admin-provisioned accounts in `app_users` (`apps/backoffice/src/lib/auth.ts`),
  the gateway as `POST /api/vacancies/batch`, storage on the `cv-artifacts` PVC, and a
  poll-based live board instead of realtime WebSockets (D12). Do not reintroduce either
  provider, and do not add a signup form.
* **The extension's candidate-facts editor.** The popup's *Candidate facts* form (name, contacts,
  salary, availability, work rights, English level - `PUT /api/profile` from the popup) was removed
  2026-10-03: it was a second writer keyed to whichever account the extension was signed in as, and
  every card is grounded in its **owner's** row anyway (invariant 25). The facts have one maintenance
  surface - the `application_profile` row, edited by `/sources` (`CandidateFactsEditor.tsx` for the
  facts and `StandingAnswersEditor.tsx` for the standing answers, added 2026-10-08 because nothing
  wrote the facts) and loaded wholesale by `scripts/seed_profile.py`.
  Do not add a second editor inside the extension.
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
  removed and `apps/worker/utils/db.SCHEMA_SQL` is the only schema; see D10.)


## 6. Entry points (in apps/worker/)

| File | Role | Notes |
|---|---|---|
| `config.py` | Every env-overridable setting | Import-safe without provider SDKs; calls `load_dotenv()` |
| `worker.py` | Queue consumer (the pod) | preflight -> claim -> prepare -> graph -> ack/retry/DLQ |
| `publisher.py` | Host-side dev stand-in for the API gateway | Publishes the real payload shape; `--all`, `--jd`, `--payload`. Driven by `scripts/send-test-job.ps1`. The in-app gateway (scraped batch → one message per vacancy) is `apps/backoffice/src/pages/api/vacancies/batch.ts` |
| `healthcheck.py` | Exec probes | `--mode liveness`, `readiness`, `amqp`, `render`, `all` |
| `model_state.json` | Local model-availability ledger | **Tracked but rewritten at runtime** - restore with `git checkout -- apps/worker/model_state.json` after local runs |

## 7. Verification expectations

```sh
python -m pytest -q          # hermetic: no network, no Gemini, no LibreOffice
python -m ruff check .       # must stay clean (line-length 100, target py311)
```

`apps/worker/tests/test_postgres_store.py` only runs when `TEST_DATABASE_URL` points at a
throwaway Postgres (`make test-postgres`); otherwise its 27 tests skip. A change
that touches the DB, queue, DOCX mutator or retry logic is not done until the
suite passes. The automation's four tables (`resume_interview`, `process_runs` and the
board's own two) are pinned there, and `apps/worker/tests/test_archiver.py` / `apps/worker/tests/test_process_runs.py`
assert the *policy* hermetically with an injected store.

The `apps/backoffice/` layer has its own hermetic gates - run them for any change there:

```sh
cd apps/backoffice
npm test             # vitest: auth, board helpers, interviews, details, history lines, run log, batch validation, scraper (jsdom)
npx tsc --noEmit     # types (no mypy equivalent on this side)
npm run build        # SSR bundle must build
```

## 8. When code and prose disagree

The **code wins**, and the disagreement belongs in section 5 of this file in the
same change. Documentation that is allowed to drift silently is worse than no
documentation.

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
4. **Pre-declared queue arguments must equal `apps/worker/utils/messaging.py`'s declaration**
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
7. **Items the root `AGENTS.md` already carries are not repeated here**: the idle
   heartbeat and the `0/1` readiness probe (its trap 20), the KEDA CRDs `helm uninstall`
   leaves behind (trap 14) and the free tier's 20-requests/day model quota
   (`docs/RUNBOOK.md`, `python scripts/check_models.py --strict`).


8. **The `cv-files` helper owns `/data/input` and `/data/output` as `10001:10001`**
    (`fileManager.owner`). The worker runs unprivileged (`runAsUser: 10001`), so
    root-owned directories made the first task die at `persist` with
    `[Errno 13] Permission denied: '/data/output/<name>.pdf'`.
9. **The `helm test` pod needs the same broker env as the Deployment**
    (`RABBITMQ_HOST/PORT/VHOST` + the credentials from the broker Secret): those are
    injected in the Deployment only, so the probe used to compose `guest@localhost:5672`
    and always failed.
10. **All four worker Deployments need a distinct `cv-tailoring.io/workload` selector
    label.** The base worker's selector was left as the bare `selectorLabels` helper, which
    is a *subset* of the cover/apply/rerender pods' labels, so each KEDA HPA matched all
    four Deployments and refused to scale (`ScalingActive=False`, `AmbiguousSelector`). The
    tailoring consumer stayed at `fallback.replicas` (1) while a 5-message backlog drained
    one job at a time - which the operator saw as cards stuck in "Tailoring In Progress"
    (2026-10-07). `spec.selector` is immutable, so the fix had to delete and recreate the
    Deployment.
