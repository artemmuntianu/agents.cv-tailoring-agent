# cv-tailoring-scout

The scheduled vacancy intake: `python -m scout` in the worker's image, as a **CronJob**.

What one run does (and nothing else):

1. fetches every feed in `config.feeds` (the three DOU ones by default);
2. parses each item - role/company/location/salary, the vacancy id from the link, the
   description as plain text;
3. de-duplicates against the **board** (any owner, any status, refused cards included);
4. creates one `resumes` row per new vacancy with `status = 'submitted'` - a card in the
   board's **Scraped** column;
5. sends one Telegram message per new card (`config.notify: telegram`).

It calls **no model** and publishes **no message**: the operator's drag into Prepare queues the
tailoring (`CONSTITUTION.md` invariants 23 and 25). That is why a run is free no matter how many
vacancies it finds, and why `config.maxPerRun` defaults to `0` (everything).

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

## Values that matter

| Value | Default | Notes |
|---|---|---|
`enabled` | `true` | renders nothing when false |
`schedule` | `0,30 7-23 * * *` | wall-clock, with `timeZone: Europe/Lisbon` |
`suspend` | `false` | pause the intake without deleting it |
`existingSecret` | `cv-tailoring-secrets` | needs `DATABASE_URL` + `SCOUT_TELEGRAM_TOKEN`/`_CHAT_ID` |
`config.userId` | – | **required at runtime**: a provisioned `app_users.id`, or the preflight refuses to run |
`config.notify` | `telegram` | `none` creates the cards silently |

The bot token never appears in this chart, in `values.yaml` or in git: `scripts/worker-secret.ps1`
adds it to the Secret from the gitignored `.env`.
