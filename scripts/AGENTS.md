# scripts/ - operator tooling

The code a human runs *against infrastructure* rather than inside the pipeline:
deploy, put the master CV on the cluster volume, create the Secret, verify the
Gemini model id. Nothing here is imported by `agent/` or `utils/`.

Read `CONSTITUTION.md` first; chart structure and cluster traps are in
`charts/AGENTS.md`.

## Tools

| Tool | Language | Purpose |
|---|---|---|
| `local-deploy.ps1` | PowerShell | Build the image, make it visible to the cluster, resolve chart deps, create the Secret, `helm upgrade --install`, **force the worker rollout** (a rebuild with the same image tag does not change the pod template, so without `rollout restart` an upgrade ships nothing new - the 2026-09-29 lesson), print status. Flags: `-SkipBuild`, `-Uninstall` (keeps PVCs), `-Release`, `-Namespace`, `-Values`, `-Image`, `-LocalDbUrl` |
| `storage-files.ps1` | PowerShell | `-Action seed` pushes `cv.docx`, `cv_data.json` and any `jd_*.txt` to `/data`; `list`, `download` (tailored **PDFs and DOCX** -> `artifacts\output` - the board serves both), `path` (prints the `ARTIFACTS_DIR`/`OUTPUT_DIR` lines that point the board straight at the cluster volume - no mirror, no copy), `purge` (delete the artifacts a removal queued, then clear `artifact_purge`), `shell`. Everything except `path` talks to the `cv-files` pod, so it works while the worker is scaled to zero; `purge` also reads the queue through `deploy/postgres` (`-PgTarget`/`-DbUser`/`-Database` default to the dev values) |
| `send-test-job.ps1` | PowerShell | Publishes one vacancy (or `-All`) from the host to the in-cluster broker the only way that works: opens its own `kubectl port-forward`, rebuilds `RABBITMQ_URL` against `localhost` (the Secret's URL names the in-cluster DNS), forces `QUEUE_BACKEND=amqp`, and refuses to publish until the release and the master CV on the volume exist. `-Smoke` publishes under a fresh id, `-DryRun` prints the plan, `-KeepForward` leaves the tunnel up, and `-UserId <uuid>` sets the owner - without it the worker has no `application_profile` row to read, so the **CANDIDATE FACTS block is empty** and the card is owned by nobody (`coalesce(user_id,'local')` in the idempotency key) |
| `worker-secret.ps1` | PowerShell | Creates `cv-tailoring-secrets` from `.env` (`GEMINI_API_KEY`, `DATABASE_URL`, plus `SCOUT_TELEGRAM_TOKEN`/`SCOUT_TELEGRAM_CHAT_ID` when present - the scout's CronJob borrows this Secret, so the bot token lives in exactly one object and never in a chart); real environment variables win over the file; `-DryRun` prints what it would do **without** the values. Pass `-DatabaseUrl` when `.env` has no `DATABASE_URL` - `local-deploy.ps1` always does (with the in-cluster URL), so the bare `make worker-secret` only works where `.env` carries one |
| `fetch-fonts.ps1` | PowerShell | Copies the licensed Calibri family (`calibri*.ttf`, `calibril*.ttf`) out of `C:\Windows\Fonts` into the untracked `deploy\fonts\`, which `docker build` bakes into the image (`/usr/share/fonts/truetype/ms-calibri/` + `fc-cache -f`) so LibreOffice stops rendering Calibri Light in DejaVu Serif (`CONSTITUTION.md` D15). `-Source` for a font dump kept elsewhere, `-DryRun` prints the plan and writes nothing, and a partial set warns without failing - the image is valid either way. The files are Microsoft-licensed: gitignored, never committed, and an image built with them must not be published |
| `check_models.py` | Python | Lists the models this API key can use and checks `MODEL_NAME`; `--strict` exits 1 when it is unavailable and prints the `--set` snippet to deploy with |
| `seed_profile.py` | Python | Writes a candidate-facts JSON (`artifacts\candidate_profile.json` by default) into the operator's `application_profile` row through `utils/db` - the way a whole answer set is loaded (the facts have no UI editor: `/sources` renders the row, this script writes it). The payload runs through `utils/candidate.sanitize()`, so a value the caps would cut is reported instead of being stored silently. `--user <uuid>` to write, `--dry-run` to print the sanitized document and what the prompts would carry. A host-side run needs `kubectl port-forward svc/postgres 5432:5432` and `DATABASE_SSLMODE=disable` (trap 18) |
| `backfill_interviews.sql` | SQL | The written record of the one-off **Interviews backfill** (2026-09-27). The five cards standing in Interviewing had their interviews only in `resume_history` (the 2026-09-26 import wrote every sheet step as a `move` row, so the dates are the sheet's and the times are **midnight**), so one interview per move *into* interviewing is inserted, with `type` + `result` taken from that transition's own note (else from the first informative note after it - never the importer's `Last state=...` metadata row and never the bare word "Interview"), the `Imported: ` prefix stripped, a placeholder for a card with no such move, and nothing at all for a card that already has an interview. Idempotent: the second run is a no-op. Run it with `kubectl exec -i deploy/postgres -- psql ... < scripts\backfill_interviews.sql` (its header carries that command and the host-side variant) |
| `backdate_imported_clocks.sql` | SQL | The written record of the one-off **board-clock repair** (2026-10-01). The 2026-09-26 spreadsheet import wrote `resume_board` rows directly, so `updated_at` took its `now()` default: nine cards in `applied` looked "touched" at the import (2026-09-26 23:18:23 - the same microsecond) although their real last activity is the date the import itself recorded in `resume_history.at`. The inactivity sweep therefore reported `candidates: 0` every morning while a card silent since 2026-09-18 stayed put (the operator reported two of them). It back-dates only cards whose **whole history is the import**, that are not archived, and that were stamped during the import window (`< 2026-09-27`) - to the newest timestamp the import wrote; a card the operator touched later keeps its clock, and a details save writes no history row on purpose (invariant 28). Idempotent (the column only moves backwards) and it touches no other column. Run it with `kubectl exec -i deploy/postgres -- psql ... < scripts\backdate_imported_clocks.sql` (its header carries that command and the host-side variant) |
| `reown_scout_cards.sql` | SQL | The written record of the one-off **scout-cards re-own** (2026-10-03). Every prompt is grounded in the candidate facts of the card's **owner**, and the scheduled intake filed its cards under a separate `scout@local` account whose `application_profile` row held placeholders (`location = 'Ukraine (remote)'`) - so `/sources` showed the operator `Portugal` while every scouted card was drafted from `Ukraine` (Djinni 851326). It deletes that placeholder facts row, drops any scout card that duplicates one the operator already owns (the unique business key includes `source`; 0 such conflicts on 2026-10-03), and re-owns the rest to `u-03ac63cd26651373`. Child tables hang off `job_id` (`on delete cascade`), and no history row is rewritten. Idempotent. Pairs with `cv-tailoring-scout.config.userId` in `deploy/values/dev.yaml` (invariant 25). Run it with `kubectl exec -i deploy/postgres -- psql ... < scripts\reown_scout_cards.sql` (its header carries that command and the host-side variant) |
| `backfill_interview_history.sql` | SQL | The written record of the one-off **interview-history backfill** (2026-10-01): interviews became audited operator activity (`CONSTITUTION.md` invariant 26, revised), so the eight interviews that predate the change each get one line - `Interview added: <type>, <YYYY-MM-DD HH:MM>`, `kind='move'`, actor `Candidate`, `from_state = to_state` = the card's current column - **dated at the interview's own `created_at`**, so the line lands where the write happened. It deliberately does **not** touch `resume_board.updated_at`: refreshing that clock now would claim work that did not happen today, and the inactivity sweep dates cards by it (`archiver/AGENTS.md`). Idempotent (the same action text is never inserted twice for a card; cards without a board row are skipped). Run it with `kubectl exec -i deploy/postgres -- psql ... < scripts\backfill_interview_history.sql` (its header carries that command and the host-side variant) |
| `archive_not_applicable.sql` | SQL | **Not in the tree, and never was** (`CONSTITUTION.md` D13): this row used to describe the file as the written record of the 2026-09-26 spreadsheet import, but `git log --all` has no such path. The *import* is real and still visible in the data - 828 `resume_history` rows carry the `Imported: ` prefix and 121 cards are refused as `Candidate` / `Not applicable` with **stage untouched** - so only the script is missing |

Broker credentials are deliberately **not** in `worker-secret.ps1`: the chart
injects `RABBITMQ_USERNAME` / `RABBITMQ_PASSWORD` from the same Secret KEDA uses,
so the password lives in exactly one place.

## Contract

- `local-deploy.ps1` order matters: tools -> Docker daemon -> cluster context ->
  image -> **make the image visible** -> chart deps -> Secret -> helm -> status.
  kind nodes keep their own image store, so it detects kind by node name
  (`*-control-plane` / `*-worker*`) and runs `kind load docker-image`; without the
  kind CLI it falls back to what that command does under the hood - `docker save`
  -> `docker cp` into the node container -> `docker exec <node> ctr -n k8s.io
  images import`; a k3d cluster gets `k3d image import`; kubeadm / Docker Desktop
  share Docker's store and need nothing.
- `local-deploy.ps1` calls `worker-secret.ps1` (step 7) - never duplicate the
  Secret creation in a second script.
- Fonts are a **build-time** input, never a cluster one: a Secret or ConfigMap cannot
  carry them (the 1 MiB object limit against ~8 MB of Calibri), so `fetch-fonts.ps1`
  fills `deploy\fonts\` and the `Dockerfile` installs it. That is the single exception
  to `.dockerignore` ignoring `deploy/`, written as `deploy/*` + `!deploy/fonts/`
  because excluding the directory itself makes a re-include a no-op - verified by a
  throwaway `COPY` build, not assumed. `local-deploy.ps1` warns when the directory is
  empty instead of failing: CI builds the same image with no fonts at all
  (`CONSTITUTION.md` D15).
- `storage-files.ps1` failing with "no `cv-files` pod found" means *deploy first*,
  not "the volume is empty".
- Publishing from the host goes through `send-test-job.ps1`. The manual
  `kubectl get secret ... rabbitmq-url` snippet in old docs fails twice and
  silently: that URL names the in-cluster DNS, and `publisher.py` defaults to the
  `directory` backend, so `QUEUE_BACKEND=amqp` is also required. The script (and
  the `-DryRun` output) is the single place that gets both right.
- `check_models.py` imports `agent.gemini.client()` (the SDK call lives there). It
  is an operator script, so this does not break the one-way `utils/ -> agent/` rule.
- Volume layout it maintains: `/data/cv_data.json`, `/data/input/cv.docx`,
  `/data/input/jd_*.txt`, `/data/output/*.docx|pdf` - the same paths
  `docs/RUNBOOK.md` and `README.md` document.

## Conventions

- PowerShell 5.1: `;` is the only command separator (never `&&` or a bare `&`),
  `$ErrorActionPreference = 'Stop'`, a `Fail` helper exits non-zero with a
  `[fail]` line, and cmdlets are preferred over cmd aliases.
- Two PowerShell 5.1 parsing/stream traps that bite every new script here:
  **never** split an expression with a *leading* operator (`+`/`-` at the start of
  the next line is a parse error - the operator goes at the end of the previous
  line, or use a backtick); and `$ErrorActionPreference = 'Stop'` turns a native
  command's **stderr** (`helm status` on a missing release, `kubectl exec` on a
  non-zero exit) into a terminating error, so the script dies before its `[fail]`
  message. `send-test-job.ps1`'s `Invoke-External` helper is the pattern to copy.
- PowerShell 5.1 also mangles native argument *content*: `--set key=(($x -split ':')[0])`
  is passed as `key=` plus a second lone token, and inside an array literal
  `'--flag=' + $value,` becomes **two** elements. That is what broke the first live
  `helm upgrade` ("requires 2 arguments") and `kubectl create secret` ("exactly one
  NAME is required, got 3"). Compute the value into a variable, then interpolate it
  into a `"key=$value"` string or pass the variable itself.
- Python scripts under `scripts/` must call
  `sys.stdout.reconfigure(encoding="utf-8")` before printing (the console is
  cp1252) and are covered by `python -m ruff check .`.
- Never echo a secret value and never write one to git - `.env` is gitignored;
  copy `.env.example`.
- Resolve paths from `$PSScriptRoot` (PowerShell) or `__file__` (Python), so the
  scripts work from any cwd and from a git worktree.

## Don't

- Add cloud steps (`az`, ACR/GHCR pushes, Bicep) - that era was removed on
  purpose (`CONSTITUTION.md` section 5).
- Re-implement file transfer with a manual `kubectl cp`/`exec` into the worker
  pod: the worker scales to zero, and `cv-files` is the reason this flow works.
- Print or commit a credential, and do not relax a `[fail]` check - each one
  guards a failure that already happened once.
- Commit the job-search spreadsheet: it carries cover letters, salary expectations and
  recruiter names. It was imported once, by hand, and stays out of the repo.
