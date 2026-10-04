"""The interface a feed source must satisfy - the whole cost of adding a site to the intake.

A **source** is a site; a **feed** is one URL of it. One module per site lives in
`apps/worker/scout/parsers/<site>.py` and exports a single `SOURCE`; `scout.sources` discovers them, and
`scout.run` asks the registry which parser a fetched URL belongs to. Nothing else in the layer
knows a site by name, so "add a feed" is a parser module plus a URL in `SCOUT_FEEDS` - not a hunt
through the code for the places that assume DOU.

The three fields of `FeedSource` are the whole contract, and each carries a reason:

* `name` - the card's `resumes.source` slug, half of the vacancy's business key
  (`resumes_job_key_idx`). The browser extension derives the *same* slug from the page it scrapes
  (`apps/extension/src/background.js::sourceForUrl`), so a vacancy found by the intake and the same
  vacancy scraped by hand are one card instead of two. The DB guard (`resumes_source_shape`)
  accepts `^[a-z0-9][a-z0-9-]{1,31}$`.
* `hosts` - the feed URLs this parser owns, matched as an exact host or a `.`-suffix (`dou.ua`
  also covers `jobs.dou.ua`). The host decides the slug, which is why a feed of an unknown host is
  refused rather than guessed at.
* `parse_feed` - pure: the feed body in, the cards out. No network, no logging, no database - so
  every site's feed contract is unit tested without a socket.
"""

from collections.abc import Callable
from dataclasses import dataclass
from typing import TypedDict
from urllib.parse import urlsplit


class Vacancy(TypedDict):
    """One card as a **parser** must return it (see `ScopedVacancy` for the routed form).

    The four prose fields may legitimately be empty - Djinni's feed carries no company, location or
    salary at all, and a parser that *can* derive them from its own feed is welcome to. Only
    `external_id` and `description_raw` are load-bearing: `parse_feed` skips an item that has no id
    or no text rather than creating a half-card, because a card the worker cannot tailor is worse
    than no card.
    """

    external_id: str
    title: str
    company: str
    location: str
    salary: str
    description_raw: str
    source_url: str
    published_at: str


class ScopedVacancy(Vacancy):
    """A card after the router stamped the site on it (`scout.run.collect`).

    The parsers stay site-pure, so the slug is added exactly once, by the one place that knew which
    feed the card came from - and it is what `store`/`telegram` read instead of a global setting.
    """

    source: str


@dataclass(frozen=True)
class FeedSource:
    """One site the intake can read (see the module docstring for what each field is for)."""

    name: str
    hosts: tuple[str, ...]
    parse_feed: Callable[[str], list[Vacancy]]
    label: str = ""

    def matches(self, url: str) -> bool:
        """True when `url` is a feed of this source's site."""
        host = host_of(url)
        return bool(host) and any(
            host == claimed or host.endswith(f".{claimed}") for claimed in self.hosts
        )


def host_of(url: str) -> str:
    """The lower-cased hostname of a URL, or '' when it has none (or is malformed)."""
    try:
        return (urlsplit(str(url or "")).hostname or "").lower()
    except ValueError:  # a malformed URL is not worth taking a run down for
        return ""
