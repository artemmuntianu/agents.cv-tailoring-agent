# archiver/ - the inactivity sweep

Refuses the board cards nobody is working on any more: `python -m archiver` archives every card
in `AUTO_ARCHIVE_STAGES` (`applied`) that no **operator action** has touched for
`AUTO_ARCHIVE_AFTER_DAYS` days (`10`). It is the housekeeping half of the automation - the
intake finds vacancies, this closes the ones that went quiet.

Read `CONSTITUTION.md` first (invariants 19, 20, 27); this file is the layer-specific detail.

## Run it

```sh
python -m archiver --dry-run     # list the cards that would be refused, write nothing
python -m archiver               # the CronJob's command
python -m archiver --stages applied,negotiating --after-days 5
python -m archiver --trigger manual    # what the ledger records (schedule | manual)
make archiver-dry-run                   # the same dry run, with DB_BACKEND/DATABASE_SSLMODE set
```

There is deliberately **no** root `archiver.py`: a package and a module with the same name in
one directory collide, and `import archiver` would quietly resolve to the package while the
script ran a different file. `python -m archiver` is unambiguous (`__main__.py` -> `run.main`).

Exit codes are part of the contract: **0** = the sweep finished (including "nothing to do"),
**1** = it could not be trusted (preflight refused, the board could not be read, or at least one
card could not be refused). The ledger row says which cards were left alone.

## Files

| File | Owns |
|---|---|
| `run.py` | The whole policy: `Sweep`, `parse_stages`, `validate_refusal`, `sweep_from`, `preflight`, `sweep`, `main` |
| `__main__.py` | `python -m archiver` |
| `AGENTS.md` | This file |

## What it does NOT do (on purpose)

- **No move.** A refusal is the board's in-place soft delete: the card keeps the column it
  stopped in and is rendered muted (invariant 19). `resume_board.stage` is never written.
- **No `resumes.status`.** That column is the worker's claim/idempotency state; the automation
  reads `resumes` and writes only the board's own tables.
- **No queue message, no Gemini.** A sweep is free however many cards it touches - the same
  reason the intake may run every 30 minutes.
- **No delete, no purge.** Removal stays the operator's confirmed action (invariant 22); the
  sweep only refuses, and `🔄 Restore` in the card is the undo.
- **No new vocabulary.** The reason is `AUTO_ARCHIVE_REASON` (`No response`, one of the eleven
  seeded `board_actions` values) and the actor is the DB's `Candidate` | `Company`. The reason
  is upserted into `board_actions` in the same transaction as the card it describes, so it is
  filterable and stays suggested.
- **No "is a run due?" logic.** The timer is the CronJob (`schedule` + `startingDeadlineSeconds`,
  which is what makes a missed slot run as soon as the cluster is back); the job is idempotent,
  so a repeated or catch-up run is safe.

## The staleness clock

`resume_board.updated_at` - the field the board dates a card by, bumped by every move, archive,
restore and recorded action (the card's `➕ Add action` button included). `resumes.updated_at`
is deliberately **not** used: the worker writes status changes there, so a tailoring run would
look like operator activity and a card could stay in Applied forever.

**A board write that is not an operator action has to back-date this column.** The 2026-09-26
spreadsheet import wrote `resume_board` rows directly and left `updated_at` on its `now()`
default, so nine cards in `applied` got a fresh ten-day clock: the sweep ran, honestly found
`candidates: 0`, and cards silent since 2026-09-18 stayed where they were - which reads like an
archiver bug and is not one. `scripts/backdate_imported_clocks.sql` is the repair (it back-dates
exactly the import-only cards), and the same rule applies to any future import or backfill: an
import reconstructs history, it does not touch cards.

Diagnose from the evidence, in this order: the ledger row (`process_runs`, `candidates`/`refused`/
`failed` - a sweep that ran with nothing to do looks exactly like a sweep that is broken, except
for its row), then `select updated_at, stage, archived_at from resume_board where job_id = ...`,
then the card's `resume_history.at`. Never widen `AUTO_ARCHIVE_AFTER_DAYS` to make a stale card
match, and never date by `resumes.updated_at`.

The `archiver` is the second writer of the board's tables besides the backoffice, and the only
one without a human behind it; it keeps the same transaction shape the board's own archive route
uses (`utils/db.py::PostgresDb.archive_card`): archive columns together, one `kind='archive'`
history row (`active` -> `archived`), one `board_actions` upsert.

## Ledger

Every run is one row in `process_runs` (`utils/process_runs.py`), read by the board's Processes
window. `running` without `finished_at` means the pod died mid-run; the next run of the same job
retires those as `aborted`. A `--dry-run` writes nothing at all - not even a ledger row.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `AUTO_ARCHIVE_STAGES` | `applied` | comma-separated columns; validated against the board's vocabulary |
| `AUTO_ARCHIVE_AFTER_DAYS` | `10` | days without an operator action |
| `AUTO_ARCHIVE_ACTOR` | `Company` | must be `Candidate` or `Company` (the DB CHECK) |
| `AUTO_ARCHIVE_REASON` | `No response` | 1..500 characters (the DB CHECK) |
| `AUTO_ARCHIVE_MAX_PER_RUN` | `50` | cap, so a first sweep cannot refuse a whole column in one run |
| `PROCESS_RUN_STALE_HOURS` | `24` | when a `running` ledger row is retired as `aborted` |
| `DB_BACKEND` | – | **must be `postgres`**: the board's columns do not exist in the JSON backend |

Deployed as its own CronJob (`charts/cv-tailoring-archiver`, `0 9 * * *` Europe/Lisbon,
`startingDeadlineSeconds: 86400`) on the worker's image and Secret.

## Testing this layer

`tests/test_archiver.py` is hermetic: the store is injected, so the policy is asserted without a
database (which cards are stale, what the ledger records, `--dry-run` writes nothing, a
non-Postgres backend refuses to run, one failing card does not end the sweep). The SQL itself
(`list_inactive_cards`, `archive_card`) is pinned by the `TEST_DATABASE_URL`-gated tests in
`tests/test_postgres_store.py`.

## Don't

- Write `resume_board.stage`, `resumes.status`, or a second kind of history row.
- Date staleness by `resumes.updated_at` (or by `created_at`): the board's own activity field is
  the contract, and a card the operator just moved must never be refused.
- Delete anything, or queue an `artifact_purge`.
- Hard-code the reason/actor/stages in code: they are the config above, exactly like the intake's
  knobs, and the defaults are the ones the operator's own vocabulary already seeds.
- Let a failure of the ledger row fail the sweep, or let one card's error end the loop.
