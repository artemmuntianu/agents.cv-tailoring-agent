"""The internal process ledger: a run is opened, always closed, and never left in flight.

Hermetic: the store is the file backend (`DB_BACKEND=local`), so the ledger's own contract is
asserted without a database. The SQL behind it is pinned by the gated Postgres tests.
"""

import tempfile

import pytest

from tests.helpers import isolated_config
from utils import db as db_module
from utils import process_runs


def test_a_run_is_opened_and_closed_even_when_the_job_returns_early():
    """A job's exit-code style (`return` inside the block) must still close the row, or the
    Processes window would show a job that never finishes."""

    def job():
        with process_runs.record(process_runs.FEED_PARSER) as ledger:
            ledger.note(feeds=3, feeds_ok=2)
            return "early"

    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            store = db_module.get_db()
            assert job() == "early"

            (run,) = store.list_process_runs()
            assert run["process"] == "feed-parser"
            assert run["trigger"] == "schedule"
            assert run["status"] == process_runs.OK
            assert run["summary"] == {"feeds": 3, "feeds_ok": 2}
            assert run["finished_at"] is not None


def test_a_crashing_run_is_closed_as_failed_and_the_error_propagates():
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            store = db_module.get_db()
            with pytest.raises(RuntimeError, match="boom"):
                with process_runs.record(process_runs.AUTO_ARCHIVER) as ledger:
                    ledger.note(stages="applied")
                    raise RuntimeError("boom")

            (run,) = store.list_process_runs()
            assert run["status"] == process_runs.FAILED
            assert "boom" in run["error"]
            # The counters reported before the crash survive - they are the run's context.
            assert run["summary"] == {"stages": "applied"}


def test_a_job_can_mark_its_own_run_failed_without_raising():
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            with process_runs.record(process_runs.FEED_PARSER) as ledger:
                ledger.fail("no feed answered")

            (run,) = db_module.get_db().list_process_runs()
            assert run["status"] == process_runs.FAILED
            assert run["error"] == "no feed answered"


def test_a_dry_run_is_not_recorded_at_all():
    """`--dry-run` means "writes nothing", and the ledger is part of what that means."""
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            with process_runs.record(process_runs.AUTO_ARCHIVER, enabled=False) as ledger:
                ledger.note(candidates=7)

            assert db_module.get_db().list_process_runs() == []


def test_a_store_that_cannot_open_a_row_does_not_break_the_job():
    """Bookkeeping must never be what fails a run: the job still reports its own outcome."""
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            store = db_module.get_db()

            def refuse(*_args, **_kwargs):
                raise RuntimeError("the database is gone")

            store.start_process_run = refuse
            with process_runs.record(process_runs.AUTO_ARCHIVER) as ledger:
                ledger.note(candidates=1)
                outcome = "the job ran"

            assert outcome == "the job ran"
            assert store.list_process_runs() == []


def test_the_next_run_retires_a_row_a_killed_pod_left_running():
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            store = db_module.get_db()
            store.start_process_run(process_runs.AUTO_ARCHIVER)
            store.start_process_run(process_runs.FEED_PARSER)

            # Age zero: the bound only exists so a *live* run is never touched.
            assert process_runs.retire_stale(process_runs.AUTO_ARCHIVER, older_than_seconds=0) == 1

            runs = {run["process"]: run for run in store.list_process_runs()}
            assert runs["auto-archiver"]["status"] == process_runs.ABORTED
            assert runs["feed-parser"]["status"] == process_runs.RUNNING, "another job is safe"

            # A wide bound leaves a fresh run alone, and re-running the sweep is a no-op.
            assert process_runs.retire_stale(process_runs.FEED_PARSER, older_than_seconds=3600) == 0
            assert process_runs.retire_stale(process_runs.AUTO_ARCHIVER, older_than_seconds=0) == 0


def test_the_ledger_lists_the_newest_run_first():
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            store = db_module.get_db()
            first = store.start_process_run(process_runs.FEED_PARSER)
            second = store.start_process_run(process_runs.FEED_PARSER)
            assert [run["id"] for run in store.list_process_runs()] == [second, first]
