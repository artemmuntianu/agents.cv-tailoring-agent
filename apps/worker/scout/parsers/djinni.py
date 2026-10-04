"""Djinni feed parsing - pure functions, one site profile like `dou.py`.

Same RSS 2.0 envelope, different shape where it matters:

* the endpoint is the **listing URL with `/jobs/rss/` instead of `/jobs/`**, so the operator's own
  search (keywords, salary, experience, employment, English level) is what the feed returns;
* `<title>` is the role alone (`Lead Platform Engineer`). Djinni's company, salary and location
  live on the listing card, not in the feed, so those three fields stay empty instead of being
  guessed from the prose;
* the item carries only `<guid>` (the same job URL) and `<category>` tags besides the common
  fields;
* the id is the number in `/jobs/<id>-<slug>/` - the same id space the extension's
  `job-item-<id>` cards use, which is what makes a scouted vacancy and a browser scrape of it one
  card (`resumes.source` finishes the job).

The description is escaped HTML with the entities double-escaped and `<br>` tags
(`custom&amp;nbsp;IT`, `Leadership &amp;amp; Collaboration`, `&lt;br&gt;` - all real), so the text
pass is the shared `scout.html_text.to_text`; unlike DOU, the feed appends no "apply" chrome.
"""

import re
import xml.etree.ElementTree as ET

from scout import html_text
from scout.contracts import FeedSource, Vacancy

# `/jobs/850592-lead-platform-engineer/` and `/jobs/850592/` are both the vacancy 850592.
VACANCY_ID_RE = re.compile(r"/jobs/(?P<id>\d+)(?:-|/|$)")


def external_id_from_link(link: str | None) -> str | None:
    """The vacancy's numeric id, or None when the link is not a Djinni job URL."""
    match = VACANCY_ID_RE.search(str(link or ""))
    return match.group("id") if match else None


def html_to_text(raw: str | None) -> str:
    """The description as plain text (see `scout.html_text` - nothing to cut here)."""
    return html_text.to_text(raw)


def parse_item(item: ET.Element) -> Vacancy | None:
    """One `<item>` -> the fields a card needs, or None when it is not a usable vacancy."""
    def text(tag: str) -> str:
        node = item.find(tag)
        return (node.text or "").strip() if node is not None and node.text else ""

    # `link` and `guid` are the same job URL; the guid is the feed's own identity, so it is the
    # fallback when a feed ever ships without a link.
    link = text("link") or text("guid")
    external_id = external_id_from_link(link)
    description = html_to_text(text("description"))
    if not external_id or not description:
        return None

    title = text("title")
    return {
        "external_id": external_id,
        "source_url": link.split("?")[0],
        # The title *is* the role: Djinni does not append a company or a location marker, and
        # inventing a split here would only misread titles like "Team Lead (.NET + Angular)".
        "title": title,
        "company": "",
        "location": "",
        "salary": "",
        "description_raw": description,
        "published_at": text("pubDate"),
    }


def parse_feed(xml_text: str) -> list[Vacancy]:
    """Every usable vacancy of one feed, in feed order. A malformed feed yields nothing."""
    if not (xml_text or "").strip():
        return []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []

    items: list[Vacancy] = []
    for item in root.iter("item"):
        parsed = parse_item(item)
        if parsed is not None:
            items.append(parsed)
    return items


SOURCE = FeedSource(name="djinni", hosts=("djinni.co",), parse_feed=parse_feed, label="Djinni")
