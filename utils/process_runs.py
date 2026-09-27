"""The internal process run ledger: one row per run of a scheduled job.

`scout` (the RSS intake) and `archiver` (the inactivity sweep) write here, and the board's
Processes window reads the rows - so a run is visible even when it changed nothing (a feed
that carried nothing new, a sweep that had nothing to archive). Before this ledger the only
trace of a scheduled job was the pod's log, which is gone by the next slot.

Three rules make the ledger trustworthy:

* **A run is always closed.** `record()` finishes the row in `finally`-fashion, so the
  window never shows a job that is actually dead.
* **A killed pod leaves a row `running` forever**, so the next run of the same job retires
  older ones as `aborted` (`retire_stale`). It is age-bounded, so a *live* run is safe.
* **The slugs are the vocabulary** (`feed-parser`, `auto-archiver`): the DB CHECK enforces
  the shape and `backoffice/src/lib/processes.ts` maps them to labels. A new job adds a
  slug here, not a column.

The ledger is deliberately not a queue or a lock: it never decides whether work runs (the
CronJob slot does), it only records what happened.
"""

from contextlib import contextmanager

import config
from utils import db as db_module
from utils.logging_setup import get_logger

log = get_logger(__name__)

# Process slugs. `feed-parser` is the scout (one row per run, whatever the feeds);
# `auto-archiver` is the inactivity sweep.
FEED_PARSER = "feed-parser"
AUTO_ARCHIVER = "auto-archiver"

# Run statuses, spelled exactly like the `process_runs.status` CHECK. A row holds
# `RUNNING` only while its job is in flight; `close` writes one of the other four.
RUNNING = "running"
OK = "ok"
FAILED = "failed"
SKIPPED = "skipped"
ABORTED = "aborted"


class RunRecord:
    """The handle a job uses to report what its run did."""

    def __init__(self, run_id):
        self.id = run_id
        self.summary = {}
        # A job that simply finishes did its job: `ok` is the default, and `fail`/`skip`
        # are the two ways to say otherwise. Nothing has to call `finish()` to be honest.
        self.status = OK
        self.error = None

    def note(self, **counters):
        """Add the counters the Processes window shows. None values are dropped."""
        self.summary.update({key: value for key, value in counters.items() if value is not None})
        return self

    def fail(self, error):
        """Mark the run failed; the window shows (a truncated) message."""
        self.status = FAILED
        self.error = str(error)[:500]
        return self

    def finish(self, status=OK):
        self.status = status
        return self


def close(run: RunRecord, store=None) -> None:
    """Write the run's outcome.

    A failure to close is logged, never raised: the job's own result is already on its way
    out, and a job must not die *because* its bookkeeping did. The row then stays `running`
    and the next run retires it as `aborted`, which is exactly what this status is for.
    """
    if run.id is None:
        log.warning("no ledger row for this run", status=run.status, error=run.error)
        return
    store = store or db_module.get_db()
    try:
        store.finish_process_run(
            run.id, status=run.status, summary=run.summary or None, error=run.error
        )
    except Exception as exc:  # noqa: BLE001 - see the docstring
        log.error("could not close the run record", process_run=run.id, error=str(exc))
        return
    log.info(
        "run closed",
        process_run=run.id,
        status=run.status,
        error=run.error,
        **{key: value for key, value in run.summary.items() if isinstance(value, (int, str))},
    )


def retire_stale(process: str, store=None, older_than_seconds=None) -> int:
    """Retire the `running` rows a killed pod left behind; returns how many."""
    store = store or db_module.get_db()
    seconds = (
        config.PROCESS_RUN_STALE_HOURS * 3600 if older_than_seconds is None else older_than_seconds
    )
    try:
        retired = store.retire_stale_process_runs(process, older_than_seconds=seconds)
    except Exception as exc:  # noqa: BLE001 - a clean-up must not stop the run
        log.warning("could not retire stale runs", process=process, error=str(exc))
        return 0
    if retired:
        log.warning("retired runs a killed pod left behind", process=process, count=retired)
    return retired


@contextmanager
def record(process: str, trigger: str = "schedule", store=None, enabled: bool = True):
    """Open one run row, hand out its `RunRecord`, and always close it.

    `return` inside the block (the jobs' exit-code style) still closes the row; an exception
    closes it as `failed` and propagates, so a crashing run is never left in flight.

    `enabled=False` (a `--dry-run`) yields a *detached* record - the job's `ledger.note(...)`
    calls stay exactly where they are and nothing at all is written. A store that refuses to
    open the row is the same kind of problem: logged, never fatal, because the bookkeeping
    must not be what breaks a job.
    """
    store = store or db_module.get_db()
    run = RunRecord(None)
    if enabled:
        try:
            run = RunRecord(store.start_process_run(process, trigger=trigger))
        except Exception as exc:  # noqa: BLE001 - see the docstring
            log.warning("could not open a run record", process=process, error=str(exc))
        retired = retire_stale(process, store=store)
        if retired:
            run.note(retired_stale_runs=retired)
    log.info("run started", process=process, trigger=trigger, process_run=run.id)
    try:
        yield run
    except Exception as exc:
        run.fail(exc)
        close(run, store=store)
        raise
    else:
        close(run, store=store)
