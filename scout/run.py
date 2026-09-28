"""The scout's orchestration: feeds -> cards in Scraped -> one Telegram message per new vacancy.

Run it as `python -m scout` (see `scout/__main__.py`) - the package owns the layer, so there is
no root `scout.py` that a same-named package would shadow.

    python -m scout --dry-run     # fetch, parse, say what would be created - writes nothing
    python -m scout               # what the CronJob runs

Why it is this small: the board queues tailoring only when the operator drags a card into
Prepare (`CONSTITUTION.md` invariant 23), so *finding* vacancies has to be automatic while
costing nothing. That is this module's whole job - create the cards, notify, exit. It never
touches Gemini, the broker, or `resumes.status` beyond the `submitted` intake status.

No site is special here: `scout.sources` decides, from a **feed's host**, which parser reads it and
what `resumes.source` slug its cards carry. That is why the flow below names no board - growing the
intake is a parser module in `scout/parsers/` plus a URL in `SCOUT_FEEDS`
(`scout/parsers/__init__.py` has the recipe).

Exit codes matter to a CronJob: 0 = the run finished (including "nothing new"), 1 = the run
could not be trusted (no feed answered, the job store refused, or the owner account is missing).
"""

import argparse
import sys
from typing import NamedTuple

import config
from scout import feeds, policy, sources, store, telegram
from scout.contracts import ScopedVacancy
from utils import db as db_module
from utils import process_runs
from utils.logging_setup import get_logger, setup_logging

log = get_logger(__name__)

# How many would-be cards the dry run prints before summarising the rest.
DRY_RUN_PREVIEW = 20


class Collected(NamedTuple):
    """One run's intake, before anything is written: what to consider, and what was left behind."""

    vacancies: list[ScopedVacancy]
    skipped_feeds: list[str]  # answered, but no parser claims the host
    stale: int  # refused: the feed dated them older than `SCOUT_MAX_AGE_DAYS`
    undated: int  # kept although the feed gave no usable date (counted, never dropped silently)


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
    # The registry decides a card's site slug, so a feed no parser claims is a configuration error
    # rather than something to guess at: refuse the run before any fetch. A card filed under the
    # wrong slug is one nobody will ever find again (`scout.sources` says why that matters).
    registry = sources.get_sources()
    unknown = [url for url in config.SCOUT_FEEDS if sources.source_for_url(url) is None]
    if unknown:
        raise RuntimeError(
            f"no parser claims the host of {unknown[0]!r} - every feed needs a module in "
            "scout/parsers/ ('Adding a feed' is in scout/AGENTS.md)"
        )

    status["sources"] = ",".join(source.name for source in registry)
    status["feeds"] = len(config.SCOUT_FEEDS)
    status["notify"] = config.SCOUT_NOTIFY
    return status


def collect(feed_bodies: list[tuple[str, str]]) -> Collected:
    """Route every answered feed to its site's parser, then apply the intake's age rule.

    The site comes from the feed's **host** (`scout.sources`), never from a setting: the slug is
    half of the vacancy's business key, and it is what the browser scrape of the same vacancy
    sends, so a wrong one forks the card instead of matching it. `preflight` already refuses a
    configuration whose feeds are unroutable; this is the second half of the same rule - never
    guess a site, skip the feed and say so.

    The age rule (`scout/policy.py`) is applied *after* parsing and *before* the cross-feed dedupe:
    a posting the feed dated weeks ago is not a card, not a duplicate and not a Telegram message.
    """
    seen: set[tuple[str, str]] = set()
    vacancies: list[ScopedVacancy] = []
    skipped_feeds: list[str] = []
    stale = 0
    undated = 0
    for url, body in feed_bodies:
        source = sources.source_for_url(url)
        if source is None:
            log.error("no parser claims this feed's host - skipping it", url=url)
            skipped_feeds.append(url)
            continue
        parsed = source.parse_feed(body)
        for vacancy in parsed:
            # The site is the feed's, and it is decided before any rule runs, so the policy below
            # sees exactly the card the rest of the run would handle.
            vacancy["source"] = source.name
        selection = policy.select(parsed)
        stale += selection.stale
        undated += selection.undated
        log.info(
            "parsed a feed",
            source=source.name,
            url=url,
            items=len(parsed),
            kept=len(selection.kept),
            too_old=selection.stale,
        )
        for vacancy in selection.kept:
            # The key is per site: DOU's 374708 and Djinni's 374708 are different vacancies, so
            # the id alone would silently drop one of them.
            key = (source.name, vacancy["external_id"])
            if key in seen:
                continue
            seen.add(key)
            vacancies.append(vacancy)

    if stale:
        log.info(
            "refused vacancies the feeds dated too long ago",
            too_old=stale,
            max_age_days=config.SCOUT_MAX_AGE_DAYS,
        )
    if undated:
        # Not a failure: a feed that stops publishing dates must not become a silent no-op.
        log.warning("kept vacancies with no usable date", undated=undated)
    return Collected(vacancies=vacancies, skipped_feeds=skipped_feeds, stale=stale, undated=undated)


def source_breakdown(vacancies: list[ScopedVacancy]) -> str:
    """`dou:12,djinni:37` - the cards per site, the one counter a multi-site run needs."""
    counts: dict[str, int] = {}
    for vacancy in vacancies:
        counts[vacancy["source"]] = counts.get(vacancy["source"], 0) + 1
    return ",".join(f"{name}:{counts[name]}" for name in sorted(counts))


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
    parser.add_argument(
        "--trigger",
        choices=("schedule", "manual", "startup"),
        default="schedule",
        help="what the ledger records this run as (a CronJob slot, a hand-run, or the deploy's "
        "startup hook)",
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
        notify=config.SCOUT_NOTIFY,
        dry_run=args.dry_run,
    )

    # The run ledger surrounds everything after the argument parsing - preflight included: a
    # run that failed before it could read a feed is exactly what the board's Processes
    # window has to show. `enabled=False` for a dry run, which must write nothing at all.
    # `--trigger` is how the two k8s triggers of the one command stay tellable apart: a CronJob
    # slot, and the startup hook that runs the same intake once per install/upgrade.
    with process_runs.record(
        process_runs.FEED_PARSER, trigger=args.trigger, enabled=not args.dry_run
    ) as ledger:
        return _run(args, ledger)


def _run(args, ledger) -> int:
    """One run: preflight -> feeds -> cards in Scraped -> Telegram, with the ledger."""
    try:
        log.info("preflight ok", **preflight())
    except Exception as exc:  # noqa: BLE001
        log.error("preflight failed - refusing to run", error=str(exc))
        ledger.fail(f"preflight failed: {exc}")
        return 1

    ledger.note(feeds=len(config.SCOUT_FEEDS), notify=config.SCOUT_NOTIFY)

    bodies = feeds.fetch_all()
    if not bodies:
        # "Every feed failed" is not "there is nothing new", and a CronJob has to see the
        # difference - otherwise a broken URL looks like a quiet week.
        log.error("no feed answered - not treating this as an empty result")
        ledger.fail("no feed answered")
        return 1

    collected = collect(bodies)
    vacancies = collected.vacancies
    # `sources` (or None, which `note` drops) is what makes a multi-site run readable on the
    # Processes window; `feeds_skipped` is the visible half of "never guess a site's slug", and
    # `max_age_days`/`stale_dropped` say whether the age rule was in force and what it refused.
    ledger.note(
        feeds_ok=len(bodies),
        parsed=len(vacancies),
        sources=source_breakdown(vacancies) or None,
        feeds_skipped=len(collected.skipped_feeds) or None,
        max_age_days=config.SCOUT_MAX_AGE_DAYS or None,
        stale_dropped=collected.stale or None,
    )
    if config.SCOUT_MAX_PER_RUN > 0 and len(vacancies) > config.SCOUT_MAX_PER_RUN:
        log.warning("capping this run", parsed=len(vacancies), limit=config.SCOUT_MAX_PER_RUN)
        vacancies = vacancies[: config.SCOUT_MAX_PER_RUN]

    try:
        fresh = store.new_vacancies(vacancies, config.CV_VERSION)
    except Exception as exc:  # noqa: BLE001
        log.error("could not read the board", error=str(exc))
        ledger.fail(f"could not read the board: {exc}")
        return 1

    ledger.note(new_cards=len(fresh))

    if args.dry_run:
        log.info("dry run - nothing was written", would_create=len(fresh))
        for vacancy in fresh[:DRY_RUN_PREVIEW]:
            print(  # noqa: T201 - a CLI whose whole purpose is human-readable output
                f"  [{vacancy['source']}] {vacancy['external_id']}  "
                f"{vacancy['company'] or '-'}  {vacancy['title']}  "
                f"[{vacancy['location'] or '-'}]"
            )
        if len(fresh) > DRY_RUN_PREVIEW:
            print(f"  ... and {len(fresh) - DRY_RUN_PREVIEW} more")
        ledger.note(dry_run=True)
        return 0

    if not fresh:
        log.info("nothing new on the feeds")
        return 0

    try:
        created = store.create_cards(fresh, config.SCOUT_USER_ID, config.CV_VERSION)
    except Exception as exc:  # noqa: BLE001
        log.error("could not create the cards", error=str(exc))
        ledger.fail(f"could not create the cards: {exc}")
        return 1

    notified = 0
    if config.SCOUT_NOTIFY == "telegram":
        for row in created:
            vacancy = row["vacancy"]
            message = telegram.build_message(vacancy, vacancy["source"])
            if telegram.send(message):
                notified += 1
    else:
        log.info("notifications are off (SCOUT_NOTIFY)", mode=config.SCOUT_NOTIFY)

    # Not `created=`: Python's logging reserves that attribute for the record's timestamp, and
    # the structured logger then silently renames the field (seen live as `created_value`).
    ledger.note(created_cards=len(created), notified=notified)
    log.info("scout finished", created_cards=len(created), notified=notified)
    log.info("next time is incremental", hint="only unseen vacancies are created/announced")
    return 0
