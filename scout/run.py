"""The scout's orchestration: feeds -> cards in Scraped -> one Telegram message per new vacancy.

Run it as `python -m scout` (see `scout/__main__.py`) - the package owns the layer, so there is
no root `scout.py` that a same-named package would shadow.

    python -m scout --dry-run     # fetch, parse, say what would be created - writes nothing
    python -m scout               # what the CronJob runs

Why it is this small: the board queues tailoring only when the operator drags a card into
Prepare (`CONSTITUTION.md` invariant 23), so *finding* vacancies has to be automatic while
costing nothing. That is this module's whole job - create the cards, notify, exit. It never
touches Gemini, the broker, or `resumes.status` beyond the `submitted` intake status.

Exit codes matter to a CronJob: 0 = the run finished (including "nothing new"), 1 = the run
could not be trusted (no feed answered, the job store refused, or the owner account is missing).
"""

import argparse
import sys

import config
from scout import dou, feeds, store, telegram
from utils import db as db_module
from utils.logging_setup import get_logger, setup_logging

log = get_logger(__name__)

# How many would-be cards the dry run prints before summarising the rest.
DRY_RUN_PREVIEW = 20


def preflight() -> dict:
    """Fail fast on what a run cannot work without."""
    status = {}
    db = db_module.get_db()
    db.ping()
    status["db"] = db.backend

    if not config.SCOUT_USER_ID:
        raise RuntimeError(
            "SCOUT_USER_ID is not set - the scout must create cards as a provisioned "
            "app_users account, or the drag's message would fork a second row"
        )
    if not db.app_user_exists(config.SCOUT_USER_ID):
        raise RuntimeError(
            f"SCOUT_USER_ID={config.SCOUT_USER_ID!r} is not an app_users row - provision it with "
            "`npm run user -- add ...` in backoffice/ first"
        )

    status["user"] = config.SCOUT_USER_ID
    status["feeds"] = len(config.SCOUT_FEEDS)
    status["notify"] = config.SCOUT_NOTIFY
    return status


def collect(feed_bodies: list[tuple[str, str]]) -> list[dict]:
    """Parse every feed body, de-duplicating across feeds (the same vacancy can appear twice)."""
    seen: set[str] = set()
    vacancies: list[dict] = []
    for url, body in feed_bodies:
        parsed = dou.parse_feed(body)
        log.info("parsed a feed", url=url, items=len(parsed))
        for vacancy in parsed:
            if vacancy["external_id"] in seen:
                continue
            seen.add(vacancy["external_id"])
            vacancies.append(vacancy)
    return vacancies


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Scheduled vacancy intake (RSS -> board cards)")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="fetch and parse, print what would be created, write nothing",
    )
    parser.add_argument(
        "--feeds",
        default=None,
        help="comma-separated feed URLs to use instead of SCOUT_FEEDS",
    )
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    # cp1252 consoles raise on the emoji and on Cyrillic titles (the repo's known trap).
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001 - an output encoding is not worth failing a run over
        pass
    if args.feeds:
        config.SCOUT_FEEDS = [url.strip() for url in args.feeds.split(",") if url.strip()]

    setup_logging()
    log.info(
        "scout starting",
        feeds=len(config.SCOUT_FEEDS),
        source=config.SCOUT_SOURCE,
        notify=config.SCOUT_NOTIFY,
        dry_run=args.dry_run,
    )

    try:
        log.info("preflight ok", **preflight())
    except Exception as exc:  # noqa: BLE001
        log.error("preflight failed - refusing to run", error=str(exc))
        return 1

    bodies = feeds.fetch_all()
    if not bodies:
        # "Every feed failed" is not "there is nothing new", and a CronJob has to see the
        # difference - otherwise a broken URL looks like a quiet week.
        log.error("no feed answered - not treating this as an empty result")
        return 1

    vacancies = collect(bodies)
    if config.SCOUT_MAX_PER_RUN > 0 and len(vacancies) > config.SCOUT_MAX_PER_RUN:
        log.warning("capping this run", parsed=len(vacancies), limit=config.SCOUT_MAX_PER_RUN)
        vacancies = vacancies[: config.SCOUT_MAX_PER_RUN]

    try:
        fresh = store.new_vacancies(vacancies, config.SCOUT_SOURCE, config.CV_VERSION)
    except Exception as exc:  # noqa: BLE001
        log.error("could not read the board", error=str(exc))
        return 1

    if args.dry_run:
        log.info("dry run - nothing was written", would_create=len(fresh))
        for vacancy in fresh[:DRY_RUN_PREVIEW]:
            print(  # noqa: T201 - a CLI whose whole purpose is human-readable output
                f"  {vacancy['external_id']}  {vacancy['company'] or '-'}  "
                f"{vacancy['title']}  [{vacancy['location'] or '-'}]"
            )
        if len(fresh) > DRY_RUN_PREVIEW:
            print(f"  ... and {len(fresh) - DRY_RUN_PREVIEW} more")
        return 0

    if not fresh:
        log.info("nothing new on the feeds")
        return 0

    try:
        created = store.create_cards(
            fresh, config.SCOUT_SOURCE, config.SCOUT_USER_ID, config.CV_VERSION
        )
    except Exception as exc:  # noqa: BLE001
        log.error("could not create the cards", error=str(exc))
        return 1

    notified = 0
    if config.SCOUT_NOTIFY == "telegram":
        for row in created:
            message = telegram.build_message(row["vacancy"], config.SCOUT_SOURCE)
            if telegram.send(message):
                notified += 1
    else:
        log.info("notifications are off (SCOUT_NOTIFY)", mode=config.SCOUT_NOTIFY)

    # Not `created=`: Python's logging reserves that attribute for the record's timestamp, and
    # the structured logger then silently renames the field (seen live as `created_value`).
    log.info("scout finished", created_cards=len(created), notified=notified)
    log.info("next time is incremental", hint="only unseen vacancies are created/announced")
    return 0
