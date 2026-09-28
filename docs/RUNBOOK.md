# Runbook

Operational procedures for the event-driven deployment. All commands assume
`NAMESPACE=default` and release `cv-tailoring` (adjust as needed).

## First install / re-install

1. `.\scripts\local-deploy.ps1` - the **first** install runs in two phases (KEDA CRDs
   first, then the worker with its ScaledObject), because Helm builds a whole release
   before creating anything and KEDA ships its CRDs as templates. Later deploys are
   single-step.
2. `.\scripts\storage-files.ps1 -Action seed` - the worker needs `/data/cv_data.json`
   and `/data/input/cv.docx` (exact paths) before any task can run.
3. `.\scripts\send-test-job.ps1 -Smoke` - publishes one vacancy with its own
   port-forward, and refuses to publish until the release and the volume are ready.
4. Re-installing after `-Uninstall`: check `kubectl get crd | findstr keda` first -
   leftover CRDs make the next install fail with "exists and cannot be imported".
5. A scaled-to-zero worker takes its logs with it: tail them live, or read the durable
   evidence instead (the `resumes` row, `/data/output/*`, the queue depth).

## Reading the worker's artifacts from the host (dev convenience)

The board serves documents out of `OUTPUT_DIR`. On a dev machine the cluster volume is a
foreign filesystem, so pick one:

1. **Read it directly - nothing is copied.** Docker Desktop keeps its PersistentVolumes on
   the VM disk, and Windows sees that disk through WSL:

   ```powershell
   .\scripts\storage-files.ps1 -Action path
   # [ok]   pv host path: /var/lib/k8s-pvs/cv-artifacts/pvc-<id>
   # [ok]   distro path: /mnt/docker-desktop-disk/data/k8s-pvs
   # [ok]   readable from the host: 40 file(s) in output
   #   ARTIFACTS_DIR=\\wsl$\docker-desktop\mnt\docker-desktop-disk\data\k8s-pvs\cv-artifacts\pvc-<id>
   #   OUTPUT_DIR=\\wsl$\docker-desktop\...\pvc-<id>\output
   ```

   Paste those two lines into `backoffice/.env` and restart the dev server. The path carries
   the PVC's own id, so re-run the action if the PVC is ever recreated (`helm uninstall` keeps
   it: the claim is annotated `helm.sh/resource-policy: keep`). With this root the board is
   looking at the *worker's* volume, so removing a vacancy deletes the real file - no
   `-Action purge` follow-up. Docker Desktop only.

2. **Mirror a copy** with `.\scripts\storage-files.ps1 -Action download` -> `artifacts\output`.
   Works on any cluster, but the copy goes stale after every batch (and removals queue their
   paths for `-Action purge`).

Symptoms of having neither: cards show `PDF · sync` / `DOCX · sync` chips, and the modal says
`is not on this machine yet` with the same two options.

## Daily checks

```bash
kubectl get pods,scaledobject
kubectl exec -it rabbitmq-0 -- rabbitmqctl list_queues name messages messages_ready messages_unacknowledged
psql "$DATABASE_URL" -c "select status, count(*) from resumes group by status order by 2 desc;"
psql "$DATABASE_URL" -c "select process, status, started_at, finished_at, summary from process_runs order by started_at desc limit 10;"
```

Healthy signs: the tailoring worker at `0` when idle while the apply and cover
workers sit at `1` (they are kept warm on purpose - a cold pod was most of the wait
for a click), `Ready` depth rises with a batch and returns to 0,
`messages_unacknowledged` ≤ max replicas, and the DLQ stays at 0.

## Scheduled intake (the scout)

`CronJob cv-tailoring-cv-tailoring-scout` fetches the DOU and Djinni feeds every 30 minutes between
07:00 and 23:30 Lisbon time, creates one card per new vacancy in the board's **Scraped** column, and
sends one Telegram message for each. Each feed is parsed by its own site's module (`scout/parsers/`,
picked by the URL's host), and the card carries that site's slug (`dou`, `djinni`). It never queues
tailoring - that is the operator's drag - so a run costs no Gemini request whatever it finds.

```sh
kubectl get cronjob cv-tailoring-cv-tailoring-scout      # schedule, suspend state, last run
kubectl get jobs --sort-by=.metadata.creationTimestamp   # the recent runs
kubectl logs job/<job-name> --tail=50                    # ends with "created=N notified=N"

# run one out of band
kubectl create job --from=cronjob/cv-tailoring-cv-tailoring-scout scout-manual
```

- **A deploy already ran it.** `helm upgrade` posts the startup hook Job
  (`cv-tailoring-cv-tailoring-scout-startup`, i.e. `python -m scout --trigger startup`), so a fresh
  deploy shows up on the board's **Processes** page (`/processes`) within a minute instead of up to
  half an hour later. The Job is deleted when it succeeds (the `process_runs` row is the record) and
  kept only when the hook failed - and a failed hook fails the deploy, so
  `kubectl logs job/<name>-startup` is the first place to look. Skip it once with
  `helm upgrade ... --set cv-tailoring-scout.startup.enabled=false`.
- **Nothing new arrives**: read the last job's log. `no feed answered` (exit 1) means the feeds are
  unreachable, *not* that the week is quiet - the scout refuses to report that as an empty result.
- **Pause it**: `helm upgrade ... --set cv-tailoring-scout.suspend=true`.
- **No Telegram messages**: the token and chat id live in the worker's Secret
  (`scripts/worker-secret.ps1` reads `SCOUT_TELEGRAM_TOKEN`/`_CHAT_ID` from `.env`);
  `SCOUT_NOTIFY=none` turns them off deliberately, and the cards still appear.
- **Too many cards at once**: `SCOUT_MAX_PER_RUN` caps a run (0 = everything, the default).
- **Old postings are never scraped**: a vacancy the feed itself dated more than `SCOUT_MAX_AGE_DAYS`
  days ago (7 by default; `0` disables the rule) is refused before a card exists. The run's row on
  the Processes page says `max age days` and `stale dropped`, so a quiet intake is tellable from a
  feed whose window has simply moved on.
- **A dry run** (writes nothing): `python -m scout --dry-run` on the host with `SCOUT_USER_ID`,
  `DATABASE_URL` pointed at a port-forward and `DATABASE_SSLMODE=disable` (the dev Postgres has no
  TLS; trap 18 in the root `AGENTS.md`) - see `scout/AGENTS.md`.

## Filling an application form (the extension + `apply.py`)

The extension's *Populate* button queues one `applications.draft` message per rendered form; the
`ai-agent-worker-apply` Deployment (KEDA, queue depth) drafts it with one Gemini call and writes
`resume_application`. Nothing here touches `resumes.status`, and nothing is ever submitted.

```sh
kubectl get deploy ai-agent-worker-apply          # scales 0 -> 1 -> 0 around one click
kubectl logs -l cv-tailoring.io/workload=apply --tail=30
kubectl exec postgres-0 -- psql -U cvt -d cvt -c "select job_id, status, schema_hash, model, left(error,60) from resume_application order by updated_at desc limit 5"
kubectl exec rabbitmq-0 -- rabbitmqctl list_queues name messages | grep applications.draft
```

- **"not on the board yet"**: the vacancy must be scraped *and* tailored first - *Populate* only
  reads what the board already holds.
- **"no cover letter on the board yet"**: generate the letter on the card (a separate request), then
  *Populate* again. The draft itself is cached, so the second click costs no Gemini call.
- **A changed form re-drafts**: the snapshot hash changed. Intended - and it is also why editing the
  candidate facts invalidates the previous plan.
- **`failed` and a dead letter**: the model broke the contract, or the card lost its description.
  The row says why; the payload is in `applications.draft.dlq`.
- **A new site needs no deployment**: the picker stores a recipe per host in
  `chrome.storage.local`. A site whose upload widget is not a plain `input[type=file]` needs an
  adapter in `extension/src/formfill.js` (`adapterFor`).

## Scheduled housekeeping (the auto-archiver)

`CronJob cv-tailoring-cv-tailoring-archiver` refuses the board's **Applied** cards that no
operator action (a move, an archive, a restore, a recorded action) has touched for
`AUTO_ARCHIVE_AFTER_DAYS` days (10) - the same in-place archive the card's `⛔️ Archive` button
makes, recorded as `Company` / `No response`. It never moves a card, never writes
`resumes.status`, never queues a message and deletes nothing; the card's `🔄 Restore` is the undo.
It runs once a day at 09:00 Lisbon, and a slot missed while the cluster was down starts as soon as
the cluster is back (`startingDeadlineSeconds: 86400`) - the sweep is idempotent, so a late run is
harmless while a silently skipped day would not be.

```sh
kubectl get cronjob cv-tailoring-cv-tailoring-archiver     # schedule, suspend state, last run
kubectl create job --from=cronjob/cv-tailoring-cv-tailoring-archiver archiver-manual
kubectl logs job/archiver-manual                           # ends with "refused=N failed=0"
```

- **What did it refuse?** `select * from process_runs order by started_at desc limit 5;` - the
  board's **Processes** window shows the same rows - and each refusal is a normal
  `resume_history` row (`archive`, `active -> archived`), so the card's own history says why.
- **Turn it down**: `--set cv-tailoring-archiver.config.afterDays=30`, or
  `--set cv-tailoring-archiver.suspend=true` to stop it entirely.
- **Keep one card**: record an action on it (`➕ Add action`) - that bumps the card's activity
  date, which is exactly the clock the sweep reads.
- **A dry run** (lists the candidates, writes nothing): `python -m archiver --dry-run` on the host
  with `DATABASE_URL` pointed at a port-forward and `DATABASE_SSLMODE=disable` (the dev Postgres
  has no TLS; trap 18 in the root `AGENTS.md`) - see `archiver/AGENTS.md`.

## Queue is backing up (messages_ready grows, workers stay at 0)

1. `kubectl get scaledobject cv-tailoring-cv-tailoring-worker -o yaml | grep -A5 status`
   — look for `Ready`/`Active` conditions and scaler errors.
2. Check the broker the way the scaler does (it uses the management API,
   `protocol: http`, with the URL from the Secret's `rabbitmq-management-url` key):
   `kubectl exec -it rabbitmq-0 -- rabbitmqctl status | head`
   `kubectl exec -it rabbitmq-0 -- rabbitmqctl list_queues name messages messages_ready messages_unacknowledged`
3. If the metrics endpoint is broken, the `fallback.replicas` value keeps at
   least one worker running; raise it temporarily:
   `helm upgrade ... --set cv-tailoring-worker.keda.fallback.replicas=3`
4. Check the `TriggerAuthentication` secret exists in the same namespace:
   `kubectl get secret rabbitmq-credentials -o jsonpath='{.data.rabbitmq-password}' | base64 -d`

## Workers keep restarting (CrashLoopBackOff)

```bash
kubectl logs -l app.kubernetes.io/component=ai-worker --previous --tail=100
```
The worker refuses to start when preflight fails (by design — fail fast):

| Symptom | Cause | Fix |
|---|---|---|
| `missing render tool(s): ...` | image built without poppler/libreoffice | rebuild from `Dockerfile` |
| `GEMINI_API_KEY`/`DATABASE_URL` missing | Secret not created | `make worker-secret` |
| `DATABASE_URL is not set` | missing Secret key | same as above |
| `MODEL_NAME=... is not available for this API key` | placeholder model id | `python scripts/check_models.py --strict`, then set the real ids via `--set cv-tailoring-worker.config.modelName=...` |
| `prepared statement ... does not exist` / pooler errors | prepared statements against a pooled endpoint | keep `DB_PREPARE_STATEMENTS=false` (default) |
| liveness probe fails | `/tmp/cvt` not writable (fsGroup) | check `podSecurityContext` |
| task restarts from scratch, broker logs `missed heartbeats from client, timeout: 60s` | `AMQP_HEARTBEAT_SECONDS` below the task duration (the graph blocks pika's I/O loop) | keep it above the longest task (`--set cv-tailoring-worker.config.amqpHeartbeatSeconds=1800`) |
| `rabbitmq-0` boots, then `BOOT FAILED: Please create virtual host "/" prior to importing definitions` | `load_definitions` is set but the definitions file declares no vhost/user | use the chart's definitions (they declare vhost+user+permissions); the broker only re-imports at boot, so restart it after editing them |
| publish fails with `406 PRECONDITION_FAILED - inequivalent arg 'x-dead-letter-exchange'` | the pre-declared queue's arguments differ from `utils/messaging.py` | align `rabbitmqDefinitions.definitions.queues` with the code, delete the queue and restart the broker |
| a long node (`adapt_text`, `vision_check`) with `transient API error - backing off` | Gemini quota: **20 requests/day per model on the free tier** | wait for the reset, switch `MODEL_NAME` to another model from `PREFERRED_MODELS` (own quota), or enable billing |
| row ends `failed`/`dead_lettered` with `[Errno 13] Permission denied: '/data/output/...'` | `/data/output` is owned by root, not by the worker's uid | the `cv-files` pod chowns `/data/input` + `/data/output` to `fileManager.owner` (10001:10001) on start; redeploy with `-SkipBuild` |
| `helm test` fails while the worker itself is healthy | the chart probe pod lacked the broker env (`RABBITMQ_HOST`, credentials) | upgrade the chart - the test hook now carries the same env as the Deployment |

## Dead-letter queue

```bash
# inspect without consuming
kubectl exec -it rabbitmq-0 -- rabbitmqadmin --username="$U" --password="$P" \
  get queue=resumes.generate.dlq count=5 ackmode=ack_requeue_true

# replay everything after fixing the root cause
kubectl exec -it rabbitmq-0 -- sh -c 'rabbitmqadmin --username="$U" --password="$P" \
  queue=... ' # or via the management UI: Queues -> resumes.generate.dlq -> Move messages
```
Requeue target: `resumes.generate`. Bump `cv_version` if the master CV changed.

## Gemini quota exhausted (429 / daily RPD)

* The retry path is automatic: each failing model is written to
  `model_availability` (shared ledger), the next preferred model is tried, and an
  exhausted quota routes the message to a TTL retry queue with the row marked
  `rate_limited`.
* Inspect: `psql "$DATABASE_URL" -c "select * from model_availability;"`
* Force a clean slate:
  `psql "$DATABASE_URL" -c "delete from model_availability;" \
   -c "update app_settings set value='{\"current_model\":\"gemini-3.5-flash\"}' where key='model_state';"`
* Cap the blast radius per batch:
  `--set cv-tailoring-worker.keda.maxReplicaCount=5`.

## Rotate a secret

All three Secrets in one idempotent step (values come from `.env`, never git):

```bash
powershell -ExecutionPolicy Bypass -File scripts/worker-secret.ps1   # or: make worker-secret
kubectl rollout restart deploy/ai-agent-worker
```

```bash
kubectl create secret generic cv-tailoring-secrets \
  --from-literal=GEMINI_API_KEY=... --from-literal=DATABASE_URL=... \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl rollout restart deploy/ai-agent-worker
```

## Scale / cost controls

| Goal | Setting |
|---|---|
| hard cap on parallel spend | `cv-tailoring-worker.keda.maxReplicaCount` |
| stop all new work | `kubectl scale scaledobject ... --replicas=0` (or suspend KEDA autoscaling) |
| drain the queue faster | raise `maxReplicaCount` and `keda.queueLength` (e.g. `"2"` = 1 pod / 2 messages) |
| keep the *tailoring* pod warm too (latency) | `cv-tailoring-worker.keda.minReplicaCount=1` - the apply and cover workers are already warm by default; this one then costs an idle 250m/512Mi |

## After a schema change (the worker owns the DDL)

`utils/db.py::SCHEMA_SQL` is the **only** DDL, and the worker executes it at start-up
(`PostgresDb.ensure_schema`). The board deliberately does not duplicate it, so after a
schema change the database has to be upgraded once before the board can read the new
columns:

```powershell
kubectl port-forward svc/postgres 5432:5432      # keep it running
$env:DATABASE_URL = 'postgresql://cvt:cvt@localhost:5432/cvt?sslmode=disable'
$env:DB_BACKEND   = 'postgres'
python -c "from utils import db; db.get_db().ping()"
```

The cheapest alternative is to let any task run (`.\scripts\send-test-job.ps1 -Smoke`):
every `worker.py` start runs the same bootstrap. The migrations are guard-first and
idempotent, so running them twice is a no-op - the 2026-09-26 one renamed the Actor
vocabulary (`Me`/`Them` -> `Candidate`/`Company`) and added `resume_board.archived_*`
plus `board_actions`.

## Rollback

```bash
helm history cv-tailoring
helm rollback cv-tailoring            # previous revision
helm rollback cv-tailoring <rev>      # specific revision
kubectl rollout status deploy/ai-agent-worker
```

Charts are `--atomic`: a failed upgrade already rolls itself back. In-flight
tasks are safe either way — the message is only acked after `persist`.
