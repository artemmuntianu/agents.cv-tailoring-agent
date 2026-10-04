"""The intake's policy: which parsed vacancies deserve a card, and the counts that explain the rest.

A feed is a window, not a stream of news: it keeps returning the same postings, including the ones
nobody would apply to any more. The board is the operator's working set, so the intake refuses what
a feed dated too far back (`SCOUT_MAX_AGE_DAYS`, 14 days by default) - one rule, in one place, rather
than a per-site guess inside a parser.

Two edges are deliberate, and both exist so a feed can never silently become a no-op:

* the age comes from the feed's own date (the parsers keep it verbatim, warts and all): RFC-822 for
  RSS (`<pubDate>`), ISO-8601 for Atom (`<published>`). A vacancy with **no usable date is kept**
  and counted - the rule judges what a feed said, not what it omitted;
* the limit is a cutoff on whole days old (`age > limit` is refused), so `0` turns the rule off
  instead of refusing everything.

The browser scrape is out of scope on purpose: it carries no publication date, and the operator is
looking at the page anyway.
"""

from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import NamedTuple

import config
from scout.contracts import ScopedVacancy

SECONDS_PER_DAY = 86400


class Selection(NamedTuple):
    """What the policy kept, plus the counters the run's ledger reports."""

    kept: list[ScopedVacancy]
    stale: int  # refused: the feed dated it older than the limit
    undated: int  # kept, although the feed said nothing usable about when it was published


def parse_feed_date(published_at: str | None) -> datetime | None:
    """The feed's own date in either standard form, or None when it is unusable.

    Both formats a feed may use are read with the stdlib: RFC-822 is RSS's
    (`Tue, 15 Sep 2026 13:07:09 +0300`, `parsedate_to_datetime`) and ISO-8601 is Atom's
    (`2026-09-29T16:06:54Z`). Reading only the first would leave every Atom card *undated*, i.e.
    exempt from the age rule - a site's oldest postings would land on the board as new.
    """
    text = str(published_at or "")
    try:
        return parsedate_to_datetime(text)
    except (TypeError, ValueError):
        pass
    try:
        # `Z` is normalised because `fromisoformat` only reads it from Python 3.11 on.
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def published_age_days(published_at: str | None, now: datetime | None = None) -> float | None:
    """How many days ago the feed dated this vacancy, or None when it gave no usable date.

    The offset is honoured, so a feed's own timezone cannot move a vacancy across the cutoff; a date
    without one is read as UTC rather than thrown away.
    """
    published = parse_feed_date(published_at)
    if published is None:
        return None
    if published.tzinfo is None:
        published = published.replace(tzinfo=UTC)
    reference = now or datetime.now(UTC)
    return (reference - published).total_seconds() / SECONDS_PER_DAY


def select(
    vacancies: list[ScopedVacancy], max_age_days: int | None = None, now: datetime | None = None
) -> Selection:
    """Split the parsed vacancies into the cards worth creating and the counters of the rest.

    `max_age_days`/`now` exist for the tests and for a caller that already knows both; left out,
    the limit is `SCOUT_MAX_AGE_DAYS` and "now" is the wall clock.
    """
    limit = config.SCOUT_MAX_AGE_DAYS if max_age_days is None else max_age_days
    kept: list[ScopedVacancy] = []
    stale = 0
    undated = 0
    for vacancy in vacancies:
        age = published_age_days(vacancy.get("published_at"), now=now)
        if age is None:
            undated += 1
            kept.append(vacancy)
        elif limit > 0 and age > limit:
            stale += 1
        else:
            kept.append(vacancy)
    return Selection(kept=kept, stale=stale, undated=undated)
