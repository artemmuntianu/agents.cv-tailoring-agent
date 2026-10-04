"""The feed-source registry: which parser owns a feed URL, and what slug its cards get.

Discovery only - no network, no configuration. One module per site lives in `apps/worker/scout/parsers/` and
exports `SOURCE`; dropping such a module in (plus a URL in `SCOUT_FEEDS` and a fixture in the
tests, which the suite enforces) is the whole of adding a site. This is what keeps the rest of the
layer site-blind: `run.collect` routes bodies with `source_for_url`, and `store` writes the slug
the parser's own module declares.

`source_for_url` mirrors `apps/extension/src/background.js::sourceForUrl`, and that is load-bearing
rather than cosmetic: the extension derives the same slug from the page it scrapes, so this
function is what decides whether a scouted vacancy and the browser scrape of the same vacancy are
one card (`resumes_job_key_idx`) or two. One deliberate difference: the extension calls an unknown
host `other`, while the intake refuses to attribute a card to a site it does not know - a wrong
slug is worse than a missing card, because it is a card nobody will ever find again.
"""

import importlib
import pkgutil

from scout import parsers
from scout.contracts import FeedSource
from utils.logging_setup import get_logger

log = get_logger(__name__)

_cache: tuple[FeedSource, ...] | None = None


def validate(registry: tuple[FeedSource, ...]) -> None:
    """Refuse a registry that would let two sites share a card space or a host.

    Both are silent-corruption bugs rather than crashes: two parsers writing the same slug would
    merge two sites' ids into one card space (the second site's vacancies would look like
    duplicates of the first's), and two parsers claiming one host would make routing depend on
    import order. Both are also invisible in review, so they fail loudly here instead.
    """
    names = [source.name for source in registry]
    clashing_names = sorted({name for name in names if names.count(name) > 1})
    if clashing_names:
        raise ValueError(f"two parsers claim the same source slug: {clashing_names}")
    claimed: dict[str, str] = {}
    for source in registry:
        for host in source.hosts:
            if host in claimed:
                raise ValueError(f"{source.name} and {claimed[host]} both claim the host {host!r}")
            claimed[host] = source.name


def load() -> tuple[FeedSource, ...]:
    """Import every `apps/worker/scout/parsers/<site>.py` and collect its `SOURCE`."""
    found: list[FeedSource] = []
    for module_info in pkgutil.iter_modules(parsers.__path__):
        if module_info.name.startswith("_"):
            continue
        module = importlib.import_module(f"{parsers.__name__}.{module_info.name}")
        source = getattr(module, "SOURCE", None)
        if source is None:
            log.warning("a parser module exports no SOURCE - ignored", module=module.__name__)
            continue
        if not isinstance(source, FeedSource):
            raise ValueError(f"{module.__name__}.SOURCE must be a FeedSource")
        found.append(source)

    registry = tuple(found)
    validate(registry)
    if not registry:
        raise ValueError(f"no feed source found in {parsers.__name__} - the intake would read nothing")
    return registry


def get_sources() -> tuple[FeedSource, ...]:
    """Every known site, in module order (cached: discovery is per run, not per vacancy)."""
    global _cache
    if _cache is None:
        _cache = load()
    return _cache


def reset_sources_cache() -> None:
    """Drop the discovery cache - the test hook this layer's other factories have."""
    global _cache
    _cache = None


def source_for_url(url: str) -> FeedSource | None:
    """The source that owns this feed URL, or None when no parser knows its host."""
    for source in get_sources():
        if source.matches(url):
            return source
    return None
