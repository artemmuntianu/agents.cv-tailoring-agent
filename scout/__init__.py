"""Scheduled vacancy intake: feeds -> cards in the board's Scraped column (+ a Telegram message).

Entry point: `python -m scout` (`__main__.py` -> `run.main`). Read `scout/AGENTS.md` for the feed
contract, the "adding a feed" recipe, and what this layer deliberately does not do.
"""

from scout import (  # noqa: F401  (one import for the layer)
    contracts,
    feeds,
    html_text,
    parsers,
    policy,
    run,
    sources,
    store,
    telegram,
)

__all__ = [
    "contracts",
    "feeds",
    "html_text",
    "parsers",
    "policy",
    "run",
    "sources",
    "store",
    "telegram",
]
