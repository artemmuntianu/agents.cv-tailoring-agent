# cv-tailoring-archiver

The scheduled **inactivity sweep**: `python -m archiver` in the worker's image, as a CronJob.

What one run does (and nothing else):

1. reads the board for cards in `config.stages` (`applied`) whose **last operator action** -
   a move, an archive, a restore, a recorded action - is older than `config.afterDays` days
   (`10`);
2. refuses each of them in place, exactly like the card's `⛔️ Archive` button:
   `resume_board.archived_at/archived_actor/archived_reason` together, one
   `kind = 'archive'` history row, the reason upserted into `board_actions`;
3. records the run in the process ledger (`process_runs`), which the board's **Processes**
   window reads.

It **never moves a card** (the column is where the application stopped), never writes
`resumes.status` (the worker's claim state), never queues a message, never calls a model and
never deletes anything (removal stays the operator's confirmed action -
`CONSTITUTION.md` invariants 19, 20, 22, 27). A refusal is undone by `🔄 Restore` in the card.

## Install / run

```sh
helm dependency update infra/charts/cv-tailoring-platform   # the umbrella vendors this chart
helm lint infra/charts/cv-tailoring-archiver

# run one now (the CronJob itself fires on the schedule)
kubectl create job --from=cronjob/cv-tailoring-cv-tailoring-archiver archiver-manual
kubectl logs job/archiver-manual

# what the *next* run would refuse - the same command on the host, against a port-forward,
# with the configuration the ConfigMap holds (it writes nothing):
kubectl port-forward svc/postgres 5432:5432
$env:DB_BACKEND="postgres"; $env:DATABASE_URL="postgresql://cvt:cvt@localhost:5432/cvt"
cd apps/worker
python -m archiver --dry-run
```

The cron name is `<release>-cv-tailoring-archiver` (release `cv-tailoring`, so
`cv-tailoring-cv-tailoring-archiver`).

## Values that matter

| Value | Default | Notes |
|---|---|---|
| `enabled` | `true` | renders nothing when false |
| `schedule` | `0 9 * * *` | wall-clock, with `timeZone: Europe/Lisbon` |
| `startingDeadlineSeconds` | `86400` | a missed slot runs as soon as the cluster is back |
| `suspend` | `false` | pause the sweep without deleting it |
| `existingSecret` | `cv-tailoring-secrets` | needs `DATABASE_URL` (the board's tables are Postgres) |
| `config.stages` | `applied` | comma-separated columns; a typo fails the run |
| `config.afterDays` | `10` | days without an operator action |
| `config.actor` / `config.reason` | `Company` / `No response` | the refusal the history records |
| `config.maxPerRun` | `50` | cap, so a first sweep cannot refuse a whole column at once |

No secret ever appears in this chart, in `values.yaml` or in git: the sweep reads the worker's
Secret (`scripts/worker-secret.ps1`).
