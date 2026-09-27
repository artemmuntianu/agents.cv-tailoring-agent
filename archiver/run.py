"""The inactivity sweep: refuse the cards nobody is working on any more.

`python -m archiver` reads the board for cards in `AUTO_ARCHIVE_STAGES` (Applied by default)
that no *operator action* has touched for `AUTO_ARCHIVE_AFTER_DAYS` days (ten by default) and
archives them in place - the same refusal a human makes by hand, with the same actor, reason
and history row, only on a timer instead of from memory.

What it deliberately never does:

* **it never moves a card** - a refusal keeps the column the application stopped in
  (`CONSTITUTION.md` invariant 19), which is what keeps the funnel honest;
* **it never writes `resumes.status`** - that column is the worker's claim/idempotency state;
* **it never queues a message and never calls a model** - archiving costs nothing, so a sweep
  is free however many cards it touches;
* **it never deletes anything** - removal stays a human, confirmed action (invariant 22).

The clock is `resume_board.updated_at` (the board's own activity field), not anything on
`resumes`: the worker's status writes are not operator activity. The run is recorded in the
process ledger (`utils/process_runs.py`) that the board's Processes window reads, so a sweep
with nothing to do is visibly different from a sweep that never ran.

Entry point: `python -m archiver` (`__main__.py` -> `run.main`). `--dry-run` prints the
candidates and writes nothing. Read `archiver/AGENTS.md` for the layer's contract.
"""

import argparse
import sys
from dataclasses import dataclass

import config
from utils import db as db_module
from utils import process_runs
from utils.logging_setup import get_logger, setup_logging

log = get_logger(__name__)

# What a refusal must satisfy, straight from the DB guards: `resume_board_archive_shape`
# wants an actor from this vocabulary and a reason of 1..500 characters, and
# `resume_history.action` caps the same length.
ACTORS = ("Candidate", "Company")
MAX_REASON_LENGTH = 500

# The board's columns (`backoffice/src/lib/stages.ts` mirrors them). A sweep may run in any of
# them, but a typo in the config must fail the run instead of quietly matching nothing.
STAGE_IDS = ("scraped", "prepare", "applied", "negotiating", "interviewing", "offer")

# How many candidate rows a dry run prints before it summarises the rest.
DRY_RUN_PREVIEW = 20


@dataclass(frozen=True)
class Sweep:
    """The policy of one run: which cards, how stale, and what the refusal says."""

    stages: tuple
    after_days: int
    actor: str
    reason: str
    max_per_run: int


def parse_stages(raw) -> tuple:
    """The columns to sweep, validated against the board's own vocabulary."""
    stages = tuple(str(item).strip().lower() for item in raw if str(item).strip())
    unknown = [stage for stage in stages if stage not in STAGE_IDS]
    if unknown:
        raise ValueError(
            f"unknown column(s) {', '.join(unknown)} - the board has {', '.join(STAGE_IDS)}"
        )
    return stages


def validate_refusal(actor, reason) -> tuple:
    """Check the actor/reason pair the archive guard will enforce anyway.

    Cheap to do once here: a bad pair would otherwise fail every candidate of the sweep, one
    transaction at a time, and the run's exit code would be the only clue.
    """
    actor = (actor or "").strip()
    reason = " ".join((reason or "").split())
    if actor not in ACTORS:
        raise ValueError(f"AUTO_ARCHIVE_ACTOR must be one of {', '.join(ACTORS)}, not {actor!r}")
    if not reason or len(reason) > MAX_REASON_LENGTH:
        raise ValueError(f"AUTO_ARCHIVE_REASON must be 1..{MAX_REASON_LENGTH} characters")
    return actor, reason


def sweep_from(args) -> Sweep:
    """Turn the CLI and the configuration into one validated `Sweep`."""
    stages = parse_stages(args.stages.split(",") if args.stages else config.AUTO_ARCHIVE_STAGES)
    if not stages:
        raise ValueError("AUTO_ARCHIVE_STAGES is empty - there is nothing to sweep")
    after_days = (
        int(args.after_days)
        if args.after_days is not None
        else int(config.AUTO_ARCHIVE_AFTER_DAYS)
    )
    if after_days < 1:
        raise ValueError("AUTO_ARCHIVE_AFTER_DAYS must be at least 1 day")
    actor, reason = validate_refusal(config.AUTO_ARCHIVE_ACTOR, config.AUTO_ARCHIVE_REASON)
    return Sweep(
        stages=stages,
        after_days=after_days,
        actor=actor,
        reason=reason,
        max_per_run=int(config.AUTO_ARCHIVE_MAX_PER_RUN),
    )


def preflight(sweep_plan: Sweep) -> dict:
    """Fail fast on what a sweep cannot work without."""
    db = db_module.get_db()
    db.ping()
    if db.backend != "postgres":
        # The board's columns are Postgres tables and the JSON backend has no board at all,
        # so a sweep against it would "succeed" without changing anything.
        raise RuntimeError(
            "the sweep writes the board's own columns (resume_board, resume_history, "
            "board_actions), which exist only in Postgres - run it with DB_BACKEND=postgres"
        )
    return {
        "db": db.backend,
        "stages": ",".join(sweep_plan.stages),
        "after_days": sweep_plan.after_days,
        "actor": sweep_plan.actor,
        "reason": sweep_plan.reason,
        "max_per_run": sweep_plan.max_per_run,
    }



def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="Refuse board cards in the configured columns that went quiet"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print the cards that would be refused, write nothing",
    )
    parser.add_argument(
        "--stages",
        default=None,
        help="comma-separated columns to sweep (default: AUTO_ARCHIVE_STAGES)",
    )
    parser.add_argument(
        "--after-days",
        type=int,
        default=None,
        help="how many days without an operator action make a card stale",
    )
    parser.add_argument(
        "--trigger",
        choices=("schedule", "manual"),
        default="schedule",
        help="what the ledger records this run as (a CronJob slot, or a hand-run)",
    )
    return parser.parse_args(argv)


def describe(card) -> str:
    """One dry-run line: the card, where it stopped and who it is with."""
    stage = card.get("stage") or "?"
    title = card.get("title") or f"vacancy {card.get('external_id')}"
    company = card.get("company") or "unknown company"
    return f"  {card.get('job_id')}  {stage}  {title}  ({company})"


def sweep(sweep_plan: Sweep, ledger, db, dry_run: bool = False) -> int:
    """Read the candidates, then refuse them one by one; returns the exit code."""
    try:
        candidates = db.list_inactive_cards(
            sweep_plan.stages, sweep_plan.after_days, sweep_plan.max_per_run
        )
    except Exception as exc:  # noqa: BLE001
        log.error("could not read the board", error=str(exc))
        ledger.fail(f"could not read the board: {exc}")
        return 1

    log.info(
        "candidates",
        stages=",".join(sweep_plan.stages),
        after_days=sweep_plan.after_days,
        candidates=len(candidates),
    )

    if dry_run:
        for card in candidates[:DRY_RUN_PREVIEW]:
            print(describe(card))  # noqa: T201 - a CLI whose whole purpose is readable output
        if len(candidates) > DRY_RUN_PREVIEW:
            print(f"  ... and {len(candidates) - DRY_RUN_PREVIEW} more")
        log.info("dry run - nothing was refused", would_archive=len(candidates))
        ledger.note(dry_run=True, candidates=len(candidates), would_archive=len(candidates))
        return 0

    refused = 0
    failed = 0
    for card in candidates:
        try:
            if db.archive_card(card["job_id"], sweep_plan.actor, sweep_plan.reason):
                refused += 1
                log.info(
                    "refused an inactive card",
                    job_id=card.get("job_id"),
                    stage=card.get("stage"),
                    last_change=str(card.get("updated_at")),
                )
        except Exception as exc:  # noqa: BLE001 - one card must not end the sweep
            failed += 1
            log.error("could not refuse a card", job_id=card.get("job_id"), error=str(exc))

    ledger.note(candidates=len(candidates), refused=refused, failed=failed)
    log.info("archiver finished", refused=refused, failed=failed)
    if failed:
        # The sweep did part of its job: a CronJob has to be able to tell that from a clean
        # run, and the ledger row is what says which cards were left alone.
        ledger.fail(f"{failed} of {len(candidates)} cards could not be refused")
        return 1
    return 0


def main(argv=None) -> int:
    args = parse_args(argv)
    # cp1252 consoles raise on the emoji and the non-ASCII in a card title (known trap).
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001 - an output encoding is not worth failing a run over
        pass

    setup_logging()

    # The ledger surrounds the whole run, preflight included: a sweep that could not start is
    # exactly what the board's Processes window has to show. `enabled=False` for a dry run,
    # which must write nothing at all.
    with process_runs.record(
        process_runs.AUTO_ARCHIVER, trigger=args.trigger, enabled=not args.dry_run
    ) as ledger:
        try:
            plan = sweep_from(args)
            log.info("preflight ok", **preflight(plan))
        except Exception as exc:  # noqa: BLE001
            log.error("preflight failed - refusing to run", error=str(exc))
            ledger.fail(f"preflight failed: {exc}")
            return 1

        ledger.note(
            stages=",".join(plan.stages),
            after_days=plan.after_days,
            actor=plan.actor,
            reason=plan.reason,
        )
        return sweep(plan, ledger, db_module.get_db(), dry_run=args.dry_run)
