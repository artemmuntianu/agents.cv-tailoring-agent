"""Landing.Jobs feed parsing - pure functions, one site profile like `dou.py`.

The endpoint is the site's **Atom** feed (its markup advertises it as "Landing.Jobs » Offers feed").
One document carries every open vacancy of the board, so unlike DOU/Djinni there is no per-keyword
search URL to build: new-ness is what the age rule (`scout/policy.py`) decides, not the query.

Three things make this feed different from the two RSS boards:

* **It is not well-formed XML.** Every entry ends in prefixed elements (`<lj:city>`, `<lj:salary>`,
  `<lj:job_type>`, ...) whose `xmlns:lj` is declared nowhere, so a strict parser stops at the first
  one (`unbound prefix`, live feed 2026-09-30) and the whole site would quietly read as empty. The
  declaration is injected before parsing - only when it is missing, so a fixed feed keeps working;
* **the company is not in the title**: `<title>` is the role alone (`Analytics Engineer`) and the
  posting company is `<author><name>` (`Damia`, `Accenture`). Only 3 of 56 live titles carry a
  " - " marker, so nothing is split here - guessing a split would misread the rest;
* **the dates are ISO-8601** (`2026-09-29T16:06:54Z`) rather than RFC-822. The parsers keep the date
  verbatim, and `scout.policy.published_age_days` reads both formats.

The id is the vacancy's URL path (`/at/damia/uphill-health-senior-platform-engineer`), which is the
`<id>` the site itself publishes: a Landing.Jobs page carries no number, so the path is the one
identity a browser scrape of the same vacancy could derive as well. `scout.sources` derives the
slug from the host, which is why the module is named after it without its dash.
"""

import xml.etree.ElementTree as ET
from urllib.parse import urlsplit

from scout import html_text
from scout.contracts import FeedSource, Vacancy

# The site leaves its own `lj:` prefix unbound, so the URI below is ours to pick - these elements
# are only ever read here, never written back.
LJ_NAMESPACE = "urn:landingjobs"


def _local(tag: object) -> str:
    """A tag's local name, so both the Atom and the site's own elements are found by name."""
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _child(element: ET.Element | None, name: str) -> ET.Element | None:
    """The first child with this local name, whatever namespace it carries."""
    if element is None:
        return None
    for child in element:
        if _local(child.tag) == name:
            return child
    return None


def _text(element: ET.Element | None, name: str) -> str:
    """The text of that child, stripped; '' for an absent or empty one (`<lj:salary/>`)."""
    node = _child(element, name)
    return (node.text or "").strip() if node is not None and node.text else ""


def repair_prefixes(body: str) -> str:
    """Bind the feed's own `lj:` namespace before parsing (see the module docstring).

    Only when the document does not declare it already: injecting it twice would turn a valid feed
    into an invalid one.
    """
    if "xmlns:lj" in body:
        return body
    return body.replace("<feed", f'<feed xmlns:lj="{LJ_NAMESPACE}"', 1)


def external_id_from_url(url: str | None) -> str | None:
    """The vacancy's URL path, or None when the URL is not a Landing.Jobs vacancy page."""
    path = urlsplit(str(url or "")).path.rstrip("/")
    return path if path.startswith("/at/") else None


def link_of(entry: ET.Element) -> str:
    """The vacancy's own page, minus the feed's tracking query (`?utm_source=rss`)."""
    href = ""
    for child in entry:
        if _local(child.tag) != "link":
            continue
        candidate = child.get("href") or ""
        if not candidate:
            continue
        if child.get("rel", "alternate") == "alternate":
            href = candidate
            break
        href = href or candidate
    return href.split("?")[0] if href else ""


def location_of(entry: ET.Element) -> str:
    """`lj:city` + `lj:country`, falling back to the nested `lj:location` block."""
    city, country = _text(entry, "city"), _text(entry, "country")
    if not (city or country):
        block = _child(entry, "location")
        city, country = _text(block, "city"), _text(block, "country")
    return ", ".join(part for part in (city, country) if part)


def html_to_text(raw: str | None) -> str:
    """The description as plain text (see `scout.html_text`).

    Nothing is cut: the feed's own header line ("At Damia (Permanent), in Lisbon, Portugal /
    Expires at: ... / Remote policy: ...") is the posting's terms rather than apply machinery, and
    it also grounds the tailoring prompt. The logo `<img>` loses its tag like any other element.
    """
    return html_text.to_text(raw)


def parse_entry(entry: ET.Element) -> Vacancy | None:
    """One Atom `<entry>` -> the fields a card needs, or None when it is not a usable vacancy."""
    link = link_of(entry)
    external_id = external_id_from_url(_text(entry, "id") or link)
    description = html_to_text(_text(entry, "content") or _text(entry, "summary"))
    if not external_id or not description:
        return None

    return {
        "external_id": external_id,
        "source_url": link,
        "title": _text(entry, "title"),
        "company": _text(_child(entry, "author"), "name"),
        "location": location_of(entry),
        "salary": _text(entry, "salary"),
        # `updated` is only the fallback: Atom requires it and `published` is the optional one, so
        # a date the feed states is worth more than the age rule having nothing to judge.
        "published_at": _text(entry, "published") or _text(entry, "updated"),
        "description_raw": description,
    }


def parse_feed(xml_text: str) -> list[Vacancy]:
    """Every usable vacancy of one feed, in feed order. A malformed feed yields nothing."""
    if not (xml_text or "").strip():
        return []
    try:
        root = ET.fromstring(repair_prefixes(xml_text))
    except ET.ParseError:
        return []

    items: list[Vacancy] = []
    for node in root.iter():
        if _local(node.tag) != "entry":
            continue
        parsed = parse_entry(node)
        if parsed is not None:
            items.append(parsed)
    return items


SOURCE = FeedSource(
    name="landing-jobs", hosts=("landing.jobs",), parse_feed=parse_feed, label="Landing.Jobs"
)
