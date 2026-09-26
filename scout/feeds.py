"""Feed transport: fetch each configured URL once, tolerate a broken one.

Separate from `dou.py` so the parsing stays pure and testable: this module is the only place
that touches the network, and a feed that fails (a 500, a timeout, a redirect loop) is logged
and skipped - one dead feed must not stop the intake of the others. If *every* feed fails the
caller sees an empty result and decides what that means.
"""

import urllib.error
import urllib.request

import config
from utils.logging_setup import get_logger

log = get_logger(__name__)

# DOU serves the feed to any client, but a bare urllib request is a well-known bot signature.
USER_AGENT = "cv-tailoring-scout/1.0 (+https://github.com/artem/cv-tailoring-agent)"


def fetch(url: str, timeout: int | None = None) -> str | None:
    """The feed body, or None when this URL could not be read."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(  # noqa: S310 - the URLs are operator-configured
            request, timeout=timeout or config.SCOUT_TIMEOUT_SECONDS
        ) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            return response.read().decode(charset, errors="replace")
    except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError) as exc:
        log.warning("could not read a feed", url=url, error=str(exc))
        return None


def fetch_all(urls: list[str] | None = None) -> list[tuple[str, str]]:
    """Every feed that answered, as `(url, body)` pairs; the failures are only logged."""
    bodies: list[tuple[str, str]] = []
    for url in urls or config.SCOUT_FEEDS:
        body = fetch(url)
        if body:
            bodies.append((url, body))
    return bodies
