# backoffice/ - the operator UI and the API gateway (POC)

A desktop kanban board for tracking vacancies through the hiring pipeline, plus the
authenticated gateway that turns a scraped listing page into board cards (the operator's
(SSR) + React (one client island per component) + Tailwind v4, vitest for tests.

It persists into the **same Postgres the worker uses**: it reads the worker's
`resumes` rows and owns three tables of its own (`resume_board`, `resume_history`,
`app_users`), all created by `utils/db.py::SCHEMA_SQL` - the single source of truth
(`CONSTITUTION.md` D10/D11).

Read `CONSTITUTION.md` first; the worker side is `utils/AGENTS.md`, the cluster is
`charts/AGENTS.md`, the scraper that feeds the gateway is `extension/AGENTS.md`.

## Run

Server-rendered, so it needs a reachable Postgres, a reachable broker (only for the
batch endpoint) and two secrets:

```sh
# in two other terminals, and keep them running:
kubectl port-forward svc/postgres 5432:5432
kubectl port-forward svc/rabbitmq 5672:5672

cd backoffice
npm install
cp .env.example .env      # then edit: DATABASE_URL, BACKOFFICE_JWT_SECRET, RABBITMQ_URL
node scripts/user.mjs add --email me@example.com --password=secret --name=Me --admin
npm run dev               # http://localhost:4321 -> sign in

npm test           # vitest: auth, board + archive, filters, actions, interviews, details, history lines, run log, ingest, artifacts, scraper (jsdom)
npx tsc --noEmit   # types
npm run build      # SSR bundle -> dist/{server,client}
npm start          # run the built server
```

The tables are created by the **worker** at startup (`PostgresDb.ensure_schema`), so
any deployed release already has them. A fresh database can be bootstrapped with
`python -c "from utils import db; db.get_db().ping()"` (`DB_BACKEND=postgres` +
`DATABASE_URL` set).

Two local traps worth knowing before `npm test` surprises you: the test suite and the
dev server share `node_modules/.vite`, so a hard-killed `npm run dev` can corrupt it and
`scraper.test.ts` then fails with `Cannot find module '/@fs/.../extension/src/extract.js'`
even though the file exists - clear the cache (`Remove-Item -Recurse -Force
node_modules/.vite`), see trap 17 in the root `AGENTS.md`. And `npm test` reads nothing
from the cluster: it is hermetic, so it passes with both port-forwards down.

## Layout

| Path | Owns |
|---|---|
| `src/middleware.ts` | The auth gate for **every** page and API route |
| `src/pages/login.astro`, `src/components/LoginForm.tsx` | The only auth surface (no signup) |
| `src/pages/admin.astro`, `src/components/AdminApp.tsx`, `src/components/ActionVocabulary.tsx` | `/admin` - the vocabulary admin **page** (Actions editable, the rest read-only) |
| `src/components/AppShell.tsx` | The chrome **every** page renders: the `NavBar`, the header (title · subtitle · the page's own controls) and the scrolling content region - plus sign-out, so it has one implementation |
| `src/pages/403.astro` | Where a non-admin who asks for `/admin` lands |
| `src/pages/index.astro` | The board page (the shell + `App`); passes the session name/email down |
| `src/pages/processes.astro`, `src/components/ProcessesPage.tsx`, `src/components/ProcessRunTable.tsx` | `/processes` - the internal jobs' run log as a page (read-only, unpolled) |
| `src/pages/api/board.ts` | `GET` the cards |
| `src/pages/api/board/move.ts`, `archive.ts`, `restore.ts`, `remove.ts` | The four mutations: move a card (optionally with the first interview when it enters Interviewing), refuse it, undo a refusal, purge it for good |
| `src/pages/api/board/action.ts` | `POST` an action **without** moving the card (the card's `➕ Add action`): a `move` history row with `from_state = to_state` |
| `src/pages/api/board/interviews/index.ts`, `src/pages/api/board/interviews/[id].ts` | `POST` one interview · `PATCH`/`DELETE` one - the section's own record, never a history row |
| `src/pages/api/board/details.ts` | `POST` the card's own detail fields (recruiter, the two salaries, the channels) - the whole set in one write, never a history row |
| `src/pages/api/board/history/[id].ts` | `PATCH` one history line (date, actor, wording, kind, both states) · `DELETE` one - the audit trail's only corrective write, and it touches nothing else (invariant 29) |
| `src/pages/api/processes.ts` | `GET` the internal jobs' run history (`process_runs`) for the Processes page |
| `src/pages/api/board/actions.ts` | `GET` the Action vocabulary (`board_actions`) |
| `src/pages/api/admin/vocabulary.ts`, `src/pages/api/admin/actions.ts` | Admin-only: read every vocabulary · add / reword / remove an Action |
| `src/pages/api/vacancies/batch.ts` | `POST` a scraped batch -> the cards + one AMQP message per vacancy |
| `src/pages/api/vacancies/status.ts` | `GET` "has the board got this vacancy?" for the extension's injected per-card buttons |
| `src/pages/api/artifacts/[jobId].ts` | `GET` the tailored PDF/DOCX (`?format=docx`), streamed from the artifact root |
| `src/pages/api/auth/{login,token,logout,me}.ts` | Cookie login, bearer token (extension), logout, who-am-I |
| `src/lib/auth.ts` | scrypt password hashing + HS256 session tokens + cookie/bearer extraction |
| `src/lib/users.ts` | `app_users` lookup, credential check, `last_login_at` |
| `src/lib/queue.ts` | amqplib publisher; mirrors the Python queue topology |
| `src/lib/vacancies.ts` | Pure batch validation + `ResumeTaskMessage` builder |
| `src/lib/ingest.ts` | Pure ingest decision: new card / duplicate (+ the `submitted` status) |
| `src/lib/artifacts.ts` | Server-only artifact resolution (root from `ARTIFACTS_DIR`/`OUTPUT_DIR`, traversal-refused) |
| `src/lib/artifact-link.ts` | Isomorphic `/api/artifacts/...` link builder for the React islands |
| `src/lib/db.ts` | Server-only pg pool; board reads, one transaction per move, the ingest rows, the interviews, the history corrections, the recorded action and the process-run read |
| `src/lib/board.ts` | Pure helpers: the four request parsers, grouping, the date sort, active/archived counts, history lines |
| `src/lib/filters.ts` | The toolbar's state and filtering: search, date window, stages, actions, visibility |
| `src/lib/actions.ts` | The Action combobox's ranking and normalisation (`board_actions` is the data) |
| `src/lib/interviews.ts` | The Interviews section: the four types, `hasReachedInterviewing`, the list sort/format and the interview parsers |
| `src/lib/details.ts` | The card's detail fields: the six communication channels, the draft/dirty helpers and the details parser |
| `src/lib/history.ts` | The History section: the four kinds, the states each kind may carry, the per-kind fallback transition, the edit parser and the draft helpers |
| `src/lib/processes.ts` | The Processes page's vocabulary: process labels and hints, run status chips, one-line run summaries, durations, the trigger label |
| `src/lib/admin.ts` | The admin surface's pure half: `isAdminPath`, the add/rename/remove parsers, table sorting |
| `src/lib/stages.ts`, `src/lib/types.ts` | Column, sub-state and actor vocabulary · types |
| `src/components/*` | `App` · `AppShell` · `NavBar` · `BoardToolbar` · `FilterDialog` · `KanbanBoard` · `VacancyCard` · `VacancyModal` · `ReasonDialog` · `RemoveDialog` · `ChannelSelect` · `InterviewFields` · `InterviewDialog` · `HistoryDialog` · `HistoryRemoveDialog` · `ProcessesPage` · `ProcessRunTable` · `ActionCombobox` · `LoginForm` |
| `scripts/user.mjs` | Administrator CLI: `add` / `list` / `password` / `disable` / `enable` |

## Vocabulary admin (`/admin`)

- **Admin-only, and actually enforced.** The session token carries
  `app_users.is_admin` (`lib/auth.ts`), `middleware.ts` gates `/admin` and `/api/admin/*`
  on it (403 JSON for the API, `/403` for the browser) and the routes re-check the claim.
  A token minted before the claim existed counts as **false**, so a stale cookie cannot
  reach the page - sign in again after upgrading.
- **Actions are the only editable list** (`board_actions`): add, reword, remove. The other
  three vocabularies are rendered read-only *from the code that defines them* - Actors are
  a DB CHECK, the columns are the board's shape (`isStageId`), the tailoring sub-states are
  derived from `resumes.status` - because changing any of them means changing behaviour.
- **The vocabulary is the catalogue** (`board_actions`): what the page lists is exactly what
  the dialogs suggest and what the board's Filters panel offers - one list, with no second
  history-derived half. An edit is *catalogue-only*: `resume_history` and
  `resume_board.archived_reason` keep the wording they were recorded with (the card's own
  History section still shows it), so a removed value simply stops being offered anywhere
  while the audit trail stays intact, and typing it again in a dialog re-adds it.
- Renaming **carries `uses` over** (insert the new wording, then delete the old key, one
  transaction); adding an existing wording is a 409, removing an absent one a 404.
- `lib/admin.ts` holds every rule (parsers, sorting, the path predicate), so the routes are
  thin and the behaviour is unit tested without a database.

## Auth contract

- **No signup, ever.** Accounts exist only because an administrator ran
  `node scripts/user.mjs add ...` (the design's "manual provisioning"); there is no
  route, form or API that creates a user.
- **Two delivery modes, one credential check**: browsers get an httpOnly
  `cvt_session` cookie from `POST /api/auth/login`; JSON clients (the Chrome
  extension, curl) get the same HS256 token back from `POST /api/auth/token` and send
  `Authorization: Bearer ...`.
- Tokens expire after 8 hours; `BACKOFFICE_JWT_SECRET` (16+ chars) is required, and
  a missing/weak secret fails closed instead of minting unsigned sessions.
- Passwords are scrypt hashes (`scrypt$N$r$p$salt$hash`); a login for an unknown email
  still pays for one hash so timing does not reveal whether an account exists.
- `scripts/user.mjs` is plain `.mjs` and therefore carries a copy of the hash format;
  `src/lib/user-cli.test.ts` is what keeps that copy honest.
- The middleware is the gate: `/login`, `/api/auth/{login,token,me}` and static
  assets are public, everything else needs a session (API: 401 JSON, pages: redirect
  to `/login?next=...`). `/admin` + `/api/admin/*` additionally need `is_admin` (403 JSON,
  or the `/403` page) - the claim is in the token, so the gate costs no query.
- **`app_users.is_admin` travels in the signed token**, so an account promoted (or demoted)
  by the CLI only sees the change after its next login; a token without the claim is not an
  administrator, which is the safe default for cookies minted before the claim existed.
- **Always pass the CLI's arguments as `--key=value`** (`--password=secret`). In
  `cmd.exe` - and therefore through `npm run user -- ...` - a single-quoted value keeps
  its quotes, so `--password 'secret'` provisions the *password* `'secret'` and the
  first login fails with `invalid credentials` (observed live, 2026-09-25).

## Batch gateway contract

- `POST /api/vacancies/batch` takes `{ vacancies: [{ external_id, title, company,
  description_raw, source_url }] }` - exactly what the extension scrapes.
- Validation happens **before** publishing (`src/lib/vacancies.ts`): required
  `external_id` + `description_raw`, http(s) only for `source_url`, at most 25 cards,
  duplicates within a batch collapsed. A rejected batch never reaches the broker.
- **A batch creates cards and queues nothing**, and that is the contract
  (`src/lib/ingest.ts`):
  1. read what the board already has, by business key
     (`user_id` + `source` + `external_id` + `cv_version`);
  2. insert the `resumes` row for each new vacancy with `status = 'submitted'`
     (`INGEST_STATUS`) - so the vacancy is in **Scraped** at once, and scraping costs
     neither a Gemini request nor a broker round trip.
  There is no `publish`/`retry` half any more, and therefore no compensation path: the
  drag into Prepare is what queues tailoring (next bullet).
- `submitted` is **claimable, not active**. It must never be added to
  `utils/db.py::ACTIVE_STATUSES`: an active sibling makes the worker's claim ack the
  message as a duplicate delivery and the card would sit in Scraped forever. Being
  non-active, the claim *adopts* that row - same `job_id`, status -> `processing` -
  so the card the gateway created is the card the worker finishes.
  `tests/test_postgres_store.py` pins both halves (`JobStatus.SUBMITTED not in
  ACTIVE_STATUSES`, and a pre-created `queued` row *would* be a duplicate).
- The duplicate rule is simply "already on the board": one row per user + site + vacancy
  + CV version (`resumes_job_key_idx`), refused cards included. A **failed** card is not
  re-queued by a scrape either - retrying is the operator's drag.
- **The drag into Prepare queues tailoring** (`POST /api/board/move`):
  `lib/board.ts::tailoringRequest` answers queue/retry/none, the route publishes first and
  moves second, and a card that just left Scraped is moved back if the broker refuses - so
  "in Prepare" cannot quietly mean "no message was ever sent" (`CONSTITUTION.md` invariant
  23). A card whose stored `description_raw` is still null (scraped before 2026-09-26) is
  refused with 409 instead of poisoning the DLQ.
- One message per vacancy, shaped like `agent/contracts.py::ResumeTaskMessage`
  (`user_id` = the **row's** owner, `source` = the site slug, `cv_data` omitted so the
  worker downloads the master CV it validates against `cv.docx`).
- `src/lib/queue.ts` mirrors the Python topology field for field (durable queue,
  direct DLX, DLQ binding, the 60/300/900/1800/3600s TTL retry ladder) because
  RabbitMQ rejects a mismatched redeclare with a 406. Three declarers must agree:
  this publisher, `utils/messaging.py` and the chart's definitions.
- Publishing is AMQP-only: neither the move route nor the gateway reimplements the
  `directory` backend, so `RABBITMQ_URL` (or `RABBITMQ_USERNAME`/`RABBITMQ_PASSWORD`) is
  required and a failed publish answers 502 with the broker's error. The batch route never
  touches the broker at all: `created` counts cards, and `jobIds` are the rows it made.
- `QUEUE_NAME`/`CV_VERSION` must match the worker's configmap.

## Cover letters (`POST /api/cover/<job_id>`)

- One card, one letter, **any** card: no stage requirement, archived cards included - a letter
  is application material, not a funnel step. 400 for a malformed id, 404 for an unknown card,
  409 when the vacancy has no stored job description (a card scraped before 2026-09-26 cannot
  produce a letter; the worker would dead-letter it) or when a letter is *being written right
  now*.
- Order: claim the row (`resume_cover_letter.status = 'queued'`, refused while it says
  `running`), publish to `resumes.cover`, and mark the row `failed` with the broker's error if
  the publish throws - the modal then shows why instead of a card that waits forever.
- The result comes back through the **card payload** (`coverLetter`, a `LEFT JOIN` in
  `CARD_SELECT`) and the existing 5s poll: no push channel, no second request. `lib/cover.ts`
  decides what the modal shows (`absent`/`queued`/`running`/`completed`/`failed`) and it is
  unit tested, so the component stays a rendering layer.

## Application drafts (`POST`/`GET /api/apply/<job_id>`, `GET`/`PUT /api/profile`)

The extension's *Populate* button asks the board to **draft** a rendered application form, then
polls for the plan. Same shape as the cover-letter route: claim the row, publish, and mark it
`failed` when the broker refuses.

* `POST /api/apply/<job_id>` takes the extension's snapshot (`{url, host, form: {root, html,
  fields}}`), validates it in `lib/application.ts` (the ids the extension minted, ≤80 fields,
  ≤200 KB of HTML, capped labels/options), hashes it together with the candidate facts' version and
  claims `resume_application`. `queued: false` is a normal answer - a draft for *exactly this form*
  is already in flight or already stored, and the worker acks the same snapshot without a second
  Gemini call.
* `GET /api/apply/<job_id>?schema=<hash>` is the poll: `completed` (with the plan), `running`,
  `queued`, `failed`, `stale` (the stored plan belongs to a different form - POST again) or `none`.
* `GET`/`PUT /api/profile` read and write the **candidate facts**: one `application_profile` jsonb
  row per operator (`lib/candidate.ts` sanitises against the known keys and the caps). A database
  row rather than a file, because the board runs on the host and the `apply` worker runs in the
  cluster - the shared Postgres is the only place both can see.
* `GET /api/cover/<job_id>` serves the generated letter to the extension, which pastes it into a
  form; the board itself keeps reading it through the card payload.

## Status lookup (the extension's per-card buttons)

- `GET /api/vacancies/status?external_ids=850374,850359` answers "is this already on the
  board?" for a whole listing page in **one** request (the ids are de-duplicated and the
  list is capped at `MAX_STATUS_IDS` = 200; a bad id or a missing parameter is a 400).
- `{ ok: true, cvVersion, known: { "<external_id>": { jobId, status, archived } } }` - only
  the ids the board knows appear, and `jobId` is what the extension's `Scraped` link points
  at (`/?card=<job_id>`, opened by `App.tsx`).
- It is the *same* lookup the batch route uses for dedupe (invariant 17) - so the two can
  never disagree - and it is deliberately **board-scoped**
  (`findExistingVacancies(..., { scope: 'board' })`): the board renders every row whatever
  its `user_id`, so an account-scoped answer would offer to scrape a card that is already
  visible (rows created by the CLI carry `user_id = NULL`). The `user` scope (the default)
  stays the worker-shaped business key and is still what `findExistingVacancies` means when
  called without options.
- Auth is the usual session cookie or `Authorization: Bearer` (the extension's token);
  without it the route is a 401. Not signed in is a *normal* extension state, so the buttons
  simply stay `Scrape` until the popup signs in.

## Artifact links

- **`resumes.pdf_url` / `resumes.docx_path` are storage paths, not URLs**
  (`utils/storage.LocalStorage.upload` returns `/data/output/848944.pdf` in the
  cluster). Linking one from a browser resolves it against the board's own origin and
  404s - that was a real bug. Every link in the UI goes through
  `artifactUrl(jobId)` (`src/lib/artifact-link.ts`, no node builtins, safe in islands).
- `GET /api/artifacts/<job_id>[?format=docx]` (`src/pages/api/artifacts/[jobId].ts`)
  streams the file: it reads `pdf_url`/`docx_path` from the row, takes the *file name*
  only and resolves it against `OUTPUT_DIR` (default `ARTIFACTS_DIR/output`, itself
  defaulting to the repo's `artifacts/`), refusing anything that escapes that
  directory. The route is cookie-authenticated like every other page, so
  `<a target="_blank">` works. **Both** documents are served - the `-Action download`
  mirror used to fetch only `*.pdf`, which is why a DOCX link 404'd while the PDF worked
  (fixed 2026-09-26).
- **The board only offers a link it can serve.** `fetchBoard` decorates every card with
  `artifactAvailability` (`lib/artifacts.ts`: two `stat`s against the artifact root), so a
  card whose file has not been mirrored yet shows a muted `PDF · sync` / `DOCX · sync` chip
  and the modal says which document is missing plus the command to mirror it. The `resumes`
  path alone only means "the worker stored one".
- The worker's volume is not on a dev machine, so the board has **two** ways to reach
  the documents, and neither puts a script in the loop:
  1. **Read the volume directly.** Docker Desktop keeps its PersistentVolumes on the VM
     disk, which Windows reaches through WSL
     (`\\wsl$\docker-desktop\mnt\docker-desktop-disk\data\k8s-pvs\<pvc>\output`).
     `.\scripts\storage-files.ps1 -Action path` prints the `ARTIFACTS_DIR`/`OUTPUT_DIR`
     lines for `.env`; re-run it if the PVC is ever recreated. `isWorkerVolumeRoot`
     recognises this root (`isClusterVolumePath`: Windows path + `k8s-pvs`), so a removal
     deletes the worker's real file instead of queueing it for `-Action purge`.
  2. **Mirror it** with `.\scripts\storage-files.ps1 -Action download` (writes
     `artifacts\output\`, the default root).
  When the file is in neither place the route says exactly that, with the hint, instead of
  a bare 404.

## Board contract

- **Every non-`GET` write must carry a `content-type`.** Astro's built-in `checkOrigin`
  middleware answers 403 ("Cross-site DELETE form submissions are forbidden") to a
  `POST`/`PATCH`/`DELETE` without a `content-type`, unless its `Origin` equals `Astro.url.origin` -
  and under the **standalone node adapter** (`npm start`) that origin is *not* the browser's
  host:port (measured 2026-09-27: only `Origin: http://localhost` was accepted by a server bound to
  `127.0.0.1:4399`), while `astro dev` derives it from the request's `Host` and therefore tolerates
  the browser's own origin. So every write in the UI sends `content-type: application/json`,
  **including the body-less ones** (`signOut` in `App.tsx` and `AdminApp.tsx`, the admin action
  `DELETE`, `interviewWrite` in `App.tsx`). A new client - a CLI, the extension - must do the same,
  or it is 403'd on the built server and fine in dev, which is the worst way to find out.
- **One database, three owners.** The worker owns `resumes`, `model_availability`,
  `app_settings`; the board owns `resume_board` (`job_id -> stage`) and
  `resume_history` (one row per confirmed manual change); the backoffice owns
  `app_users`. All the vacancy-linked tables reference `resumes(job_id)` with
  `on delete cascade`, so a vacancy is never copied.
- **The board never writes `resumes.status`.** That column is the worker's claim and
  idempotency state (`ACTIVE_STATUSES` in `utils/db.py`); the `created` sub-state is
  *derived* from it (`tailoringFromStatus`), which is why the modal shows it read-only.
- **Cards move only by hand**, and only through the dialog: a drop opens
  `ReasonDialog`, `Cancel`/Escape changes nothing, `Proceed` POSTs actor + reason.
  The writers that are not the dialog are the **intake** - the batch route and the
  scout, which only ever *create* cards - and the 2026-09-26 one-off spreadsheet
  import, which wrote columns and timelines directly and is now deleted
  (`scripts/archive_not_applicable.sql` is the last artifact of it). Every row that
  import wrote is prefixed `Imported: ` in `resume_history`, so an imported card can
  always be told apart from a hand-made move.
- **A dialog starts from the context, not from a blank field.** `ReasonDialog` opens with Actor
  **Candidate** ("you" - the operator is the one recording the change) and an Action the *card's
  context* decides: a move into a column offers that column's own wording (`To Prepare`,
  `To Applied`, ... - `MOVE_DEFAULT` in `src/lib/actions.ts`), and a refusal offers
  `Not Applicable` **only** for a card still in Scraped, because no application was ever made
  for it (`ARCHIVE_DEFAULT`); a refusal from any other column is a judgement call and starts
  empty. These are *defaults*, not suggestions: the catalogue still learns only what was
  confirmed.
- **The board carries the operator's own history**: that import adopted 226 cards from
  the job-search export, each stamped with the sheet's own dates, and archived the
  rows the sheet had already closed - 121 `NA` cards ("fits neither side") as
  `Candidate` / `Not applicable`, 5 refusals as `Company` / `Rejected by company`, 1 as
  `Candidate` / `Salary mismatch`. An archive never moves a card: it stays in the
  column where it stopped, rendered muted.
- **One transaction per move**: `resume_board` upsert + `resume_history` insert, so a
  card can never move without a recorded reason. Entering **Interviewing** adds the first
  interview to that same transaction, so a card cannot claim the column without the interview
  the dialog collected (or the other way round).
- **An action can be recorded without a move.** The card's `➕ Add action` opens the *same*
  dialog as a drop but POSTs to `/api/board/action`: `resume_board` keeps its `stage` and gets a
  fresh `updated_at`, and the history gets a `move` row with `from_state = to_state`. Own route
  on purpose - in Prepare a same-column move is a tailoring *retry*, so reusing
  `/api/board/move` would spend Gemini. That `updated_at` is also what keeps the headless
  inactivity sweep away from a card the operator is still working on (invariant 27).
- **Each column sorts itself.** Newest change first by default (`sortCards`, by `updated_at` -
  the same date the filters window and the sweep use); the header's `↓ Newest / ↑ Oldest` flips
  one column. The order lives in `KanbanBoard` state only: it is a way of reading the board, not
  board state.
- **Interviews are their own section, outside the history.** `resume_interview` (invariant 26):
  the section appears when the history holds a move into Interviewing *or* the card is there now
  (`hasReachedInterviewing`), so it survives a move on to Offer and is absent for a card that
  never got there. `➕ Add` / `✏️ Edit` / `✕ Remove` in the section, and the Move dialog's own
  Interview section, never write a `resume_history` row; every interview write answers with the
  re-read card, like the other mutations. The five cards that were already standing in
  Interviewing when the table arrived had their interviews derived from History once, by
  `scripts/backfill_interviews.sql` (the sheet had dates but no times, so those rows are at
  midnight - the pencil in the section is the way to fix one).
- **The card carries its own detail fields.** `resume_board.recruiter`, `salary_offered`,
  `salary_desired` and `communication_channels` (a `text[]` with a six-value CHECK) are edited in
  the card's **Details** block and saved as one set: an emptied input clears the field (NULL, never
  `''`), `updated_at` moves - so typing a recruiter counts as activity for the date window *and*
  for the inactivity sweep - and **no** `resume_history` row is written (invariant 28). The
  channels are a code + DB-CHECK vocabulary like the Actors and the interview types, not operator
  data, so they are not editable from `/admin`.
- **The History at the bottom of the card is correctable, and correcting it is not activity.**
  Every line carries *✏️ Edit* and *✕ Remove*. The edit rewrites the **whole** line
  (`PATCH /api/board/history/<id>`: date, actor, wording, kind and both states), because a
  half-fixed audit trail is still wrong; the two states are validated *against the kind*
  (`lib/history.ts`: a `move` carries column ids, a `tailoring` line the worker's sub-states,
  `archive`/`restore` the pair `active`/`archived` - the one check the table cannot make), and the
  dialog's state dropdowns follow the kind. Removing one is confirmed in its own dialog
  (`DELETE /api/board/history/<id>`), which says what goes and, when the line is a move into
  Interviewing, that the **Interviews** section goes with it while the interview rows stay on the
  card. Neither write touches anything else: no column change, no `resume_board.updated_at` bump
  (so a correction cannot buy a card another ten days from the sweep, invariant 27), no
  `board_actions` upsert (fixing what a line says is not a new action name) and no second history
  row - the correction is not dated, which is exactly why the dialog spells it out (invariant 29).
  The id in `HistoryEntry`/`Interview` is typed `number` but arrives as a **string** (node-pg reads
  `int8` as text): it is only ever put into a URL, so nothing converts it - do not start doing
  arithmetic on an id.
- **Every dialog closes on a click on the overlay** (the panel stops the click) as well as on
  Escape and Cancel - the full-screen card included. A dialog *inside* the card (interview,
  channel picker) handles Escape in the **capture phase** and stops it, or the card would close
  underneath it. The Filters panel is the one popover, and it already closed on an outside click.
- **The columns have a fixed width and the board scrolls sideways.** Five columns are wider than
  a laptop screen on purpose: `w-80` per column in `KanbanBoard` (one class to change), a
  horizontally scrolling row inside `main`, and each column's own card list scrolling vertically.
  Nothing is squeezed into a fifth of the viewport any more.
- **Every page wears the same chrome** (`AppShell`): the `NavBar` panel, a header with the page's
  title, its one-line subtitle and the page's own controls, and a content region that is what
  scrolls (the viewport is fixed, so the panel and the header stay put on a long run log). `/`
  (the board), `/processes` (the run log) and `/admin` (the vocabularies) are three routes on that
  one shell - which is also why sign-out has a single implementation.
- **The nav panel folds to its icons.** The `«` toggle collapses `NavBar` to the four icons
  (Board, Vocabularies, Processes, Sign out) and hides the words, the pipeline counts and the
  roadmap placeholders; the choice lives in `localStorage` under `cvt.nav.collapsed` and is read
  in an `effect`, never during render, so the server-rendered shell and the first client render
  agree. The panel deliberately has **no** reload button and no help text - a page's own controls
  (`Reload` and `● Live` on the board, `Refresh` on the run log) sit in the shell's header. The
  panel's **Pipeline** summary is board state, so only the board passes `counts`/`total`/
  `archived`: the other two pages render the panel without that block rather than paying for a
  board read they would not use.
- **The run log is a page, not a window.** `/processes` (`ProcessesPage` + `ProcessRunTable`) reads
  `GET /api/processes` (`process_runs`, newest first, written by the scheduled jobs through
  `utils/process_runs.py`). Read-only and unpolled by design - a run log is something the operator
  looks at - and an unknown process slug still renders, so a job deployed before its label appears
  anyway.
- **The board's columns have a second, headless writer.** The `archiver` CronJob refuses the
  Applied cards that went quiet (invariant 27); it uses the same transaction shape as
  `/api/board/archive` and the reason lands in `board_actions`, so the result is
  indistinguishable from a hand-made refusal - which is the point.
- **The database is the display**: after every POST the board re-reads `/api/board`,
  so a rejected move simply leaves the previous state on screen.
- **Live mode polls** `/api/board` every 5s (paused when the tab is hidden) instead of
  SSE/WebSocket: the worker writes `resumes.status` from another container, and a
  short read-only poll survives the port-forward without a connection to drop. It also
  re-reads on `focus`/`visibilitychange`, so a scrape made in the extension popup shows
  up the moment you look back at the board. Press `● Live` to pause it and fall back to
  manual Reload.
- The schema enforces what the dialogs promise: `actor in ('Candidate','Company')`, a
  non-empty action (max 500 chars), `kind in ('move','tailoring','archive','restore')` - and the
  history edit is the one place the *pair* of states is checked in code, because
  `resume_history` has no cross-column constraint to lean on.
- Tailwind class strings stay **literal** in `stages.ts` (Tailwind v4 scans text).

## Refusal: the in-place soft delete

- **A refused vacancy keeps its column.** `POST /api/board/archive` writes
  `resume_board.archived_at/actor/reason` (all three together - the DB CHECK enforces it)
  in one transaction with a `resume_history` row (`kind='archive'`, `active -> archived`)
  and the `board_actions` upsert. `stage` and `resumes.status` are untouched, so the
  funnel still shows where each application dropped out (invariant 19).
- **`restore` is one click and still audited.** `POST /api/board/restore` clears the
  three columns and writes `kind='restore'` with the recorded action
  (`RESTORE_ACTION`, actor `Candidate`) - no dialog, because there is nothing to ask, but
  the board never makes a silent change. The Action catalogue is not touched by a restore:
  nobody *types* it.
- **A refused card cannot be dragged** (it does not start a drag and the column ignores
  those drops), and moving one afterwards is allowed but unrelated: the column follows the
  operator, the archive flag stays.
- **An archived vacancy is never re-queued** (`lib/ingest.ts`): the gateway reads
  `archived_at` alongside the worker status, so re-scraping a page cannot reopen work the
  operator has closed - not even a card that was archived *because* it failed.
- 404 unknown `job_id`, 409 wrong state (already refused / not refused), 400 bad body -
  the UI reports the message and re-reads the board, which stays the display.

## Removal: the one irreversible action

- `POST /api/board/remove` purges a card **completely**: the artifact files the board can
  reach, then the `resumes` row - and with it `resume_board`, the whole `resume_history` and
  the refusal record, because both cascade. The UI guards it with `RemoveDialog` (it lists
  what disappears), and the API guards it twice: the card must be **archived** (409) and no
  worker may own the vacancy (409, `REMOVABLE_STATUSES` in `lib/board.ts`) - a task that
  finished after the purge would leave artifacts behind with nothing pointing at them.
- **The artifacts are a two-part job**, because a board outside the cluster cannot reach the
  volume: `deleteArtifact` removes what it can under `ARTIFACTS_DIR`/`OUTPUT_DIR` and reports
  `removed` (that root *is* the worker's directory, in-cluster), `mirror-only` (it deleted a
  local copy) or `absent`; everything but `removed` is queued in `artifact_purge`, and
  `scripts/storage-files.ps1 -Action purge` runs `rm -f` for those paths inside the
  `cv-files` pod and clears the queue. The route's `note` says which command to run, and the
  board shows it as a banner.
- **Nothing is tombstoned**: the vacancy becomes unknown to the system again, so re-scraping
  the same page creates a fresh card and pays for tailoring again. That is the point of
  "remove" as opposed to "archive" (invariant 22), and the dialog says so.
- 404 unknown `job_id`, 409 not archived / worker still owns it, 400 bad body.

## The toolbar and its Filters panel

- The top bar is three controls: **search**, **date range**, **Filters**. Everything else
  (visibility, columns, actions) lives in the panel, so the bar stays one row wide.
- **The date range defaults to a rolling 30 days** and is measured on the card's *last
  change* (`updated_at`, which archive and restore bump). Because a default can hide
  cards, the panel always shows `showing N of M`, the Filters button carries a badge when
  anything is off default, and the empty state offers `Show all cards`.
- **`Active Vacancies` is on and `Archived Vacancies` off by default** - the clean
  pipeline view - and the Filters panel is the only place archived cards appear.
- Stage chips and action checkboxes are additive filters; none selected = everything. An
  action filter matches a card if **any** of its history entries carries that value.
- Filtering is **client-side** over the loaded cards (`BOARD_LIMIT` = 1000): no request per
  keystroke, and `lib/filters.ts` is pure, so the rules are unit tested with an injected
  `now`. The cap is not a page: a card past it is **absent** from the UI, which is why the
  constant carries the story of the 2026-09-26 import that outgrew the old value of 200.

## Deliberately missing (it is a POC)

- No `applications.submit` producer: the design's third queue is declared in the chart
  but nothing publishes to it yet, because "apply" is still a manual board move.
- No `vacancies.parse` consumer: parsing runs in the extension against the live DOM.
- **Roles exist only for `/admin`.** The vocabulary surface requires `is_admin` (copied
  into the session token at login); the board itself is visible to every provisioned
  account. User management is the CLI (`scripts/user.mjs`) - there is no user-management
  UI.
- No rate limiting / lockout on the login endpoint.
- Worker status transitions are not copied into `resume_history`; they appear as the
  sub-state badge. Only manual changes are historicised.
- A card in Scraped is *supposed* to wait: the intake creates cards and nothing else, so
  there is no staleness rule and no background sweeper - the retry for a parked card is the
  operator's drag into Prepare again.
- The card is written by the *intake* (the batch route, and the scout), not by the worker: a
  vacancy published by anything else (`.\scripts\send-test-job.ps1 -Smoke`, `publisher.py`)
  appears when the worker claims it, not at publish time.
- No "add vacancy", no pagination (`BOARD_LIMIT` = 1000 cards, newest `updated_at` first -
  the window the toolbar filters in the browser).
- **No dark theme**: the board is light-only on purpose (`global.css` says "no dark mode
  switch"), so the UX spec's `dark:` variants are deliberately not half-applied.
- **No bulk archive/restore** and no multi-select: one card, one confirmed change.
- **Filtering is client-side** over the loaded cards; server-side filtering and paging
  are unimplemented, and the window is `updated_at` only (no "created between").
- **No undo toast** for a refusal: `🔄 Restore` *is* the undo, and it is audited.
- The Actor vocabulary is fixed in code (`Candidate`/`Company`, matching the DB CHECK);
  only Actions grow, by being typed in a dialog. Neither has an admin UI.
- **No undo for a removal** and no recycle bin: the confirm dialog is the guard, and
  re-scraping the page is the only way back.
- No removal of an active card, and no bulk removal: archive first, one card at a time.
- **No interview reminders, invitations or calendar export**: an interview is a row in the card
  and the only reminder is the card itself. The inactivity sweep ignores interviews on purpose -
  `resume_board.updated_at` is the activity clock, and a scheduled call is not an action.
- **No "run this job now" button** on the Processes page: the CronJob slot is the only timer,
  and a manual run is `kubectl create job --from=cronjob/cv-tailoring-cv-tailoring-archiver ...`
  (`charts/cv-tailoring-archiver`).
- **No interview rows in `resume_history`** - by design, not an oversight: the list in the
  section *is* the interview history (invariant 26). Do not "fix" it by adding them.
- **No History rows for the detail fields either** (recruiter, salaries, channels): like the
  interviews they are card attributes, and a History of "salary typed" lines would bury the moves
  (invariant 28).
- **No admin surface for the communication channels**: the six values are a DB CHECK, so adding
  one is a migration plus a UI change, not a row in a vocabulary table.
- **No server-side paging or sorting for the run log** (the newest 100 rows, `GET /api/processes`),
  and no filtering by process or status.
- Not deployed in-cluster yet (`CONSTITUTION.md` D11) - run it against port-forwards.

## Don't

- Add a second place to store board state (a file, another table, another service); the
  interviews (`resume_interview`) are board state in `SCHEMA_SQL` like the rest.
- Historicise an interview write, or make the Interviews section depend on an interview row
  existing: the section's visibility is the *history*, and the list is the interview history.
- Give the `➕ Add action` dialog a column to choose: an action that moves a card is a move, and
  the retry/tailoring rules belong to `/api/board/move` alone.
- Duplicate the DDL here: extend `utils/db.py::SCHEMA_SQL` and its gated test instead.
- Add a signup route, or a way to set a password from the UI.
- Write to `resumes.status`, or delete rows the worker owns. The *move* path never
  touches that column at all; the ingest path may only create rows as
  `status = 'submitted'` and may only delete rows still in that status.
- Link `card.pdfUrl`/`card.docxPath` from the UI, or read a caller-supplied path in the
  artifact route: go through `artifactUrl(jobId)` and resolve against the artifact root.
- Change the queue topology or the payload shape without changing
  `utils/messaging.py` / `agent/contracts.py` in the same change.
- Import from `agent/`/`utils/`, or add a Python dependency for this layer.
- Add "Archived" as a stage or a column, or a second archive table: the state lives in
  `resume_board.archived_*` (invariant 19) and `isStageId('archived')` must stay false.
- Prefill an Action from anywhere but `MOVE_DEFAULT`/`ARCHIVE_DEFAULT` (the dialogs' two
  context defaults): free text and the `board_actions` catalogue are the only other sources.
- Hard-code the Action suggestions in the UI: they come from `board_actions`, written by
  the same transaction as the change that used them.
- Write `Me`/`Them`: the stored vocabulary is `Candidate`/`Company` (invariant 20).
- Date a card by anything other than `updated_at` in the filters without saying so.
- Let an archived card be dragged, or let the ingest gateway re-queue one.
- Rewrite `resume_history` (or `archived_reason`) when a vocabulary value is renamed or
  removed: the audit trail keeps its wording, and a removed value simply stops being offered
  from the catalogue (invariant 21). (An operator *correcting one line* through the pencil is
  a different thing and is allowed - invariant 29.)
- Route a history correction through the move/archive machinery: `PATCH`/`DELETE
  /api/board/history/<id>` writes `resume_history` and **nothing else** - no `resume_board`
  touch, no `board_actions` upsert, no column change. A correction is not activity, and it must
  not become invisible activity either.
- Add a second home for the Action vocabulary (a JSON file, a code list, a settings table):
  `board_actions` is it, and `/admin` is the only writer.
- Make Actors, columns or sub-states editable from `/admin`: they are code/DB constraints.
- Let removal run on a card that is not archived, or on one a worker still owns.
- Delete artifacts without recording what could not be deleted: the `artifact_purge` queue
  plus `storage-files.ps1 -Action purge` is the only path that reaches inside the cluster.
