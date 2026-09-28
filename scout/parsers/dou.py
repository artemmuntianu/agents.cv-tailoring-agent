"""DOU feed parsing - pure functions, so the feed contract is unit tested.

The feed is RSS 2.0 (`<rss><channel><item>`) whose `<description>` is **escaped HTML**. The XML
layer unescapes once by itself; the second pass over the inner entities is `scout.html_text.to_text`
(`AT&amp;amp;T` is a real example from the live feed), shared with every other parser.

The vacancy id is the number in the link path
(`/companies/<slug>/vacancies/374708/?utm_source=jobsrss`). That matters more than it looks: it is
the same id space the listing page uses, so a scouted vacancy and the same vacancy scraped in the
browser are one card, not two (`resumes.source` finishes the job).

Titles read `Senior Full Stack .NET Engineer в Talmatic, $5000–6000, віддалено`: role, company and
a tail that mixes the location with the salary when the posting states one. Nothing here fails
hard: a title that does not match the pattern keeps the raw title as the role and leaves the other
fields empty, because a card with a rough title is still better than a silent gap.
"""

import re
import xml.etree.ElementTree as ET

from scout import html_text
from scout.contracts import FeedSource, Vacancy

TITLE_RE = re.compile(r"^(?P<role>.+?)\s+в\s+(?P<company>[^,]+),\s*(?P<location>.+)$")
VACANCY_ID_RE = re.compile(r"/vacancies/(?P<id>\d+)")
SALARY_RE = re.compile(r"\$[\d\s\u2013\u2014-]+(?:\$[\d\s\u2013\u2014-]+)?")
# The feed ends every description with the site's own "apply" link.
APPLY_TAIL = "Відгукнутись на вакансію"


def external_id_from_link(link: str | None) -> str | None:
    """The vacancy's numeric id, or None when the link is not a DOU vacancy URL."""
    match = VACANCY_ID_RE.search(str(link or ""))
    return match.group("id") if match else None


def parse_title(title: str | None) -> dict:
    """Split a feed title into role/company/location (+ salary when the posting states one)."""
    raw = (title or "").strip()
    match = TITLE_RE.match(raw)
    if not match:
        # No "в <company>, <tail>" shape: keep the title as the role rather than dropping it.
        return {"role": raw, "company": "", "location": "", "salary": ""}

    location = match.group("location").strip()
    salary_match = SALARY_RE.search(location)
    salary = salary_match.group(0).strip() if salary_match else ""
    if salary:
        # Remove it from the location so a card does not read "Remote, $5000".
        location = (location[: salary_match.start()] + location[salary_match.end() :]).strip(" ,")
    return {
        "role": match.group("role").strip(),
        "company": match.group("company").strip(),
        "location": location,
        "salary": salary,
    }


def html_to_text(raw: str | None) -> str:
    """The description as plain text, minus the site's own apply link (see `scout.html_text`)."""
    return html_text.to_text(raw, cut_at=APPLY_TAIL)


def parse_item(item: ET.Element) -> Vacancy | None:
    """One `<item>` -> the fields a card needs, or None when it is not a usable vacancy."""
    def text(tag: str) -> str:
        node = item.find(tag)
        return (node.text or "").strip() if node is not None and node.text else ""

    link = text("link")
    external_id = external_id_from_link(link)
    description = html_to_text(text("description"))
    if not external_id or not description:
        return None

    title = text("title")
    parts = parse_title(title)
    return {
        "external_id": external_id,
        "source_url": link.split("?")[0],  # drop ?utm_source=jobsrss
        "title": parts["role"] or title,
        "company": parts["company"],
        "location": parts["location"],
        "salary": parts["salary"],
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


SOURCE = FeedSource(name="dou", hosts=("dou.ua",), parse_feed=parse_feed, label="DOU")
