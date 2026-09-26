"""Scheduled vacancy intake: feeds -> cards in the board's Scraped column (+ a Telegram message).

Entry point: `python -m scout` (`__main__.py` -> `run.main`). Read `scout/AGENTS.md` for the feed
contract and for what this layer deliberately does not do.
"""

from scout import dou, feeds, run, store, telegram  # noqa: F401  (one import for the layer)

__all__ = ["dou", "feeds", "run", "store", "telegram"]
