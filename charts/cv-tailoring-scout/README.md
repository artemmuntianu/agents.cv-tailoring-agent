# cv-tailoring-scout

The scheduled vacancy intake: `python -m scout` in the worker's image, as a **CronJob**.

What one run does (and nothing else):

1. fetches every feed in `config.feeds` (three DOU ones and one Djinni one by default) and routes
   each URL to the parser of its **host** (`scout/sources.py`), which is also what decides the
   card's `resumes.source` slug - so adding a site is adding a feed URL;
2. parses each item - role/company/location/salary, the vacancy id from the link, the
   description as plain text (Djinni's feed carries no company/salary/location: those stay empty);
3. refuses what the feed itself dated older than `config.maxAgeDays` (7 days; `0` disables the rule):
   a feed keeps returning what it published weeks ago (`scout/policy.py`);
4. de-duplicates against the **board** (any owner, any status, refused cards included);
5. creates one `resumes` row per new vacancy with `status = 'submitted'` - a card in the
   board's **Scraped** column;
6. sends one Telegram message per new card (`config.notify: telegram`).

It calls **no model** and publishes **no message**: the operator's drag into Prepare queues the
tailoring (`CONSTITUTION.md` invariants 23 and 25). That is why a run is free no matter how many
vacancies it finds, and why `config.maxPerRun` defaults to `0` (everything) while `config.maxAgeDays`
is what keeps an old feed from filling the board.

## Install / run

```sh
helm dependency update charts/cv-tailoring-platform   # the umbrella vendors this chart
helm lint charts/cv-tailoring-scout

# run one now (the CronJob itself fires on the schedule)
kubectl create job --from=cronjob/cv-tailoring-cv-tailoring-scout scout-manual
kubectl logs job/scout-manual

# what the *next* run would add - run the same command on the host, against a port-forward,
# with the configuration the ConfigMap holds (it writes nothing):
kubectl port-forward svc/postgres 5432:5432
$env:DB_BACKEND="postgres"; $env:DATABASE_URL="postgresql://cvt:cvt@localhost:5432/cvt"
$env:SCOUT_USER_ID="<the app_users id>"; $env:SCOUT_NOTIFY="none"
python -m scout --dry-run
```

The cron name is `<release>-cv-tailoring-scout` (release `cv-tailoring`, so
`cv-tailoring-cv-tailoring-scout`).

## The startup trigger

The intake does not wait for its first slot: `templates/startup-job.yaml` is the **same Job** as a
CronJob slot (the shared pod template in `_helpers.tpl`, so image, config, Secret, resources and
`checksum/config` cannot drift between the two), created as a Helm **hook** on
`post-install,post-upgrade` and running `python -m scout --trigger startup`. So "at startup" means
*the deploy*, not half an hour later - `scripts/local-deploy.ps1` and CI both deploy with `--wait`,
and Helm does not return until the hook Job has finished.

```sh
# what a deploy does: run the intake once, then wait for it
kubectl logs job/cv-tailoring-cv-tailoring-scout-startup   # kept only if the hook failed
# skip it for one deploy (the CI render and the chart's own lint see no userId, so no hook)
helm upgrade ... --set cv-tailoring-scout.startup.enabled=false
```

Three deliberate choices:

- **A failed startup run fails the release.** `helm upgrade` exits non-zero and the script stops.
  That is the honest report - "the intake did not run" just happened - and nothing is lost by it:
  the run is idempotent (board-scoped dedupe + `upsert_job`), `backoffLimit` still retries a
  transient feed or database failure, and the next deploy or the next 30-minute slot runs it again.
  The ledger (`process_runs`, `trigger: startup`) is where the run itself is recorded.
- **The hook Job is deleted when it succeeds** (`hook-delete-policy:
  before-hook-creation,hook-succeeded`). Keeping it would make the *next* upgrade fail with
  "already exists"; the row in `process_runs` is the record, not the pod. A **failed** Job is kept
  on purpose, so its log can still be read.
- **It renders only when the intake is configured** (`config.userId` set, `startup.enabled: true`).
  The preflight refuses to run without an owner account, so a hook that could not succeed must not
  be created - otherwise a chart installed with the defaults would fail its own install.

It is a separate object from the CronJob, so `concurrencyPolicy: Forbid` does not apply to it: a
startup run can overlap a slot. That is safe by design (two intakes de-duplicating against the same
board create one card per vacancy, and the log says "another intake got there first"), which is the
same property that makes `kubectl create job --from=cronjob/...` safe.

## Values that matter

| Value | Default | Notes |
|---|---|---|
`enabled` | `true` | renders nothing when false |
`schedule` | `0,30 7-23 * * *` | wall-clock, with `timeZone: Europe/Lisbon` |
`suspend` | `false` | pause the intake without deleting it |
`startup.enabled` | `true` | if false (or `config.userId` empty) the hook Job renders not at all |
`existingSecret` | `cv-tailoring-secrets` | needs `DATABASE_URL` + `SCOUT_TELEGRAM_TOKEN`/`_CHAT_ID` |
`config.userId` | – | **required at runtime**: a provisioned `app_users.id`, or the preflight refuses to run |
`config.notify` | `telegram` | `none` creates the cards silently |

The bot token never appears in this chart, in `values.yaml` or in git: `scripts/worker-secret.ps1`
adds it to the Secret from the gitignored `.env`.
