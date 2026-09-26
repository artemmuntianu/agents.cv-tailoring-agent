# backoffice/ - the operator UI and the API gateway (POC)

A desktop kanban board for tracking vacancies through the hiring pipeline, plus the
authenticated gateway that turns a scraped listing page into queue messages. Astro
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

npm test           # vitest: auth, board, batch validation, scraper (jsdom)
npx tsc --noEmit   # types
npm run build      # SSR bundle -> dist/{server,client}
npm start          # run the built server
```

The tables are created by the **worker** at startup (`PostgresDb.ensure_schema`), so
any deployed release already has them. A fresh database can be bootstrapped with
`python -c "from utils import db; db.get_db().ping()"` (`DB_BACKEND=postgres` +
`DATABASE_URL` set).

## Layout

| Path | Owns |
|---|---|
| `src/middleware.ts` | The auth gate for **every** page and API route |
| `src/pages/login.astro`, `src/components/LoginForm.tsx` | The only auth surface (no signup) |
| `src/pages/index.astro` | Board shell; passes the session name/email down |
| `src/pages/api/board.ts`, `src/pages/api/board/move.ts` | `GET` the cards, `POST` the only mutation |
| `src/pages/api/vacancies/batch.ts` | `POST` a scraped batch -> one AMQP message per vacancy |
| `src/pages/api/auth/{login,token,logout,me}.ts` | Cookie login, bearer token (extension), logout, who-am-I |
| `src/lib/auth.ts` | scrypt password hashing + HS256 session tokens + cookie/bearer extraction |
| `src/lib/users.ts` | `app_users` lookup, credential check, `last_login_at` |
| `src/lib/queue.ts` | amqplib publisher; mirrors the Python queue topology |
| `src/lib/vacancies.ts` | Pure batch validation + `ResumeTaskMessage` builder |
| `src/lib/db.ts` | Server-only pg pool; one read query pair, one transaction |
| `src/lib/board.ts`, `src/lib/stages.ts`, `src/lib/types.ts` | Pure board helpers / column metadata / types |
| `src/components/*` | `App` · `NavBar` · `KanbanBoard` · `VacancyCard` · `VacancyModal` · `ReasonDialog` · `LoginForm` |
| `scripts/user.mjs` | Administrator CLI: `add` / `list` / `password` / `disable` / `enable` |

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
  to `/login?next=...`).
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
- One message per vacancy, shaped like `agent/contracts.py::ResumeTaskMessage`
  (`job_id` = `crypto.randomUUID()`, `user_id` = session `sub`, `cv_data` omitted so
  the worker downloads the master CV it validates against `cv.docx`).
- `src/lib/queue.ts` mirrors the Python topology field for field (durable queue,
  direct DLX, DLQ binding, the 60/300/900/1800/3600s TTL retry ladder) because
  RabbitMQ rejects a mismatched redeclare with a 406. Three declarers must agree:
  this publisher, `utils/messaging.py` and the chart's definitions.
- Publishing is AMQP-only: the gateway does not reimplement the `directory` backend,
  so `RABBITMQ_URL` (or `RABBITMQ_USERNAME`/`RABBITMQ_PASSWORD`) is required and the
  endpoint answers 502 with the broker's error when it cannot publish.
- `QUEUE_NAME`/`CV_VERSION` must match the worker's configmap.

## Board contract

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
- **One transaction per move**: `resume_board` upsert + `resume_history` insert, so a
  card can never move without a recorded reason.
- **The database is the display**: after every POST the board re-reads `/api/board`,
  so a rejected move simply leaves the previous state on screen.
- **Live mode polls** `/api/board` every 5s (paused when the tab is hidden) instead of
  SSE/WebSocket: the worker writes `resumes.status` from another container, and a
  short read-only poll survives the port-forward without a connection to drop. Press
  `● Live` to pause it and fall back to manual Reload.
- The schema enforces what the dialog promises: `actor in ('Me','Them')`, a non-empty
  action (max 500 chars), `kind in ('move','tailoring')`.
- Tailwind class strings stay **literal** in `stages.ts` (Tailwind v4 scans text).

## Deliberately missing (it is a POC)

- No `applications.submit` producer: the design's third queue is declared in the chart
  but nothing publishes to it yet, because "apply" is still a manual board move.
- No `vacancies.parse` consumer: parsing runs in the extension against the live DOM.
- No roles: every provisioned account sees the whole board (`is_admin` is stored but
  not enforced - there is no admin-only surface yet).
- No rate limiting / lockout on the login endpoint.
- Worker status transitions are not copied into `resume_history`; they appear as the
  sub-state badge. Only manual changes are historicised.
- No "add vacancy", no filters, no pagination (200 cards, newest first).
- Not deployed in-cluster yet (`CONSTITUTION.md` D11) - run it against port-forwards.

## Don't

- Add a second place to store board state (a file, another table, another service).
- Duplicate the DDL here: extend `utils/db.py::SCHEMA_SQL` and its gated test instead.
- Add a signup route, or a way to set a password from the UI.
- Write to `resumes.status`, or delete rows the worker owns.
- Change the queue topology or the payload shape without changing
  `utils/messaging.py` / `agent/contracts.py` in the same change.
- Import from `agent/`/`utils/`, or add a Python dependency for this layer.
