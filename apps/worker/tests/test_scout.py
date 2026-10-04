"""The scout: per-site parsing, host routing, board-scoped dedupe, "a scrape queues nothing".

Hermetic - the feeds are fixtures, the store is the file backend and Telegram is never called.

The registry block is the *extensibility* contract this layer is built around: a site is not
"added" until its parser exports a `SOURCE`, has a fixture in `FIXTURES` here, and every configured
feed URL routes to it. Those assertions fail the build for a half-added feed, which is the whole
point of the registry - the run never has to guess a site.
"""

import re
import tempfile
import xml.etree.ElementTree as ET
from datetime import UTC, datetime, timedelta
from email.utils import format_datetime

import pytest

import config
from scout import feeds, policy, run, sources, telegram
from scout import store as scout_store
from scout.contracts import FeedSource, ScopedVacancy, Vacancy
from scout.parsers import djinni, dou, landingjobs
from tests.helpers import isolated_config
from utils import db as db_module
from utils.messaging import cover_queue_spec, get_queue

DOU_URL = "https://jobs.dou.ua/vacancies/feeds/?remote&category=.NET&exp=5plus"
DJINNI_URL = "https://djinni.co/jobs/rss/?search_type=basic-search&salary=5000&exp_level=5y"
LANDINGJOBS_URL = "https://landing.jobs/feed"

# A fixed clock for the age-rule assertions: the rule is about dates, so no test that compares them
# may read the wall clock.
FIXED_NOW = datetime(2026, 9, 28, 12, 0, tzinfo=UTC)


def rfc822(days_ago: float, now: datetime | None = None) -> str:
    """An RFC-822 `pubDate` `days_ago` before `now` (the wall clock when no clock is given).

    The fixtures date themselves this way deliberately: a hardcoded date would rot the moment the
    age rule (`SCOUT_MAX_AGE_DAYS`, 14 days by default) started judging it.
    """
    reference = now or datetime.now(UTC)
    return format_datetime(reference - timedelta(days=days_ago))


def iso(days_ago: float, now: datetime | None = None) -> str:
    """An ISO-8601 `published` date `days_ago` before `now` - the Atom counterpart of `rfc822`.

    The shape is the live feed's own (`2026-09-29T16:06:54Z`), because a reader that only knew
    RFC-822 is exactly the bug these fixtures have to keep failing on.
    """
    reference = now or datetime.now(UTC)
    return (reference - timedelta(days=days_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")


def card(external_id: str, published_at: str) -> ScopedVacancy:
    """One parsed card, for the policy tests where only the date matters."""
    return {
        "external_id": external_id,
        "source": "dou",
        "title": f"Role {external_id}",
        "company": "",
        "location": "",
        "salary": "",
        "description_raw": "Text.",
        "source_url": f"https://jobs.dou.ua/companies/acme/vacancies/{external_id}/",
        "published_at": published_at,
    }


# A trimmed copy of the live DOU feed (2026-09-26): the description is escaped HTML, the entity is
# double-escaped (`&amp;amp;`), the link carries the utm marker, the description ends with the
# site's own apply link, and only the first item states a date - the other two are the fixture's
# "undated" cases. `{pubdate}` is filled in relative to now (see `rfc822`).
DOU_FEED = """<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>Вакансії</title>
<item>
  <title>Senior Full Stack .NET Engineer в Talmatic, $5000–6000, віддалено</title>
  <link>https://jobs.dou.ua/companies/talmatic/vacancies/374708/?utm_source=jobsrss</link>
  <description>&lt;p&gt;&lt;strong&gt;About the Role&lt;/strong&gt;&lt;/p&gt;&lt;p&gt;We use &lt;em&gt;C#&lt;/em&gt; and AT&amp;amp;T cloud.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Design APIs&lt;/li&gt;&lt;li&gt;Own delivery&lt;/li&gt;&lt;/ul&gt;
&lt;div&gt;&lt;a href="https://jobs.dou.ua/x"&gt;Відгукнутись на вакансію&lt;/a&gt;&lt;/div&gt;</description>
  <pubDate>{pubdate}</pubDate>
</item>
<item>
  <title>A role without the marker</title>
  <link>https://jobs.dou.ua/companies/acme/vacancies/361093/?utm_source=jobsrss</link>
  <description>&lt;p&gt;Plain text.&lt;/p&gt;</description>
</item>
<item>
  <title>No vacancy id in the link at all</title>
  <link>https://jobs.dou.ua/vacancies/</link>
  <description>&lt;p&gt;Ignored.&lt;/p&gt;</description>
</item>
</channel></rss>
"""

# A trimmed copy of the live Djinni feed (2026-09-28): the endpoint is the listing URL with
# `/jobs/rss/`, `<title>` is the role alone (no company marker), the link is `/jobs/<id>-<slug>/`,
# and the description is escaped HTML whose entities are double-escaped (`&amp;nbsp;`, `&amp;amp;`)
# with a `<br>` in the middle. `{pubdate}` is filled in relative to now (see `rfc822`); the second
# item keeps its literal date because the parser drops it for having no description at all.
DJINNI_FEED_TEMPLATE = """<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
<title>Latest Job Vacancies at Djinni</title><link>http://djinni.co/jobs/</link>
<atom:link href="http://djinni.co/jobs/rss/" rel="self"/><language>en</language>
<item><title>Lead Platform Engineer</title><link>https://djinni.co/jobs/850592-lead-platform-engineer/</link>
<description>&lt;p&gt;&lt;strong&gt;About you&lt;/strong&gt;&lt;/p&gt;&lt;ul&gt;&lt;li&gt;5+ years with &lt;i&gt;.NET&lt;/i&gt; and custom&amp;nbsp;IT solutions;&lt;/li&gt;&lt;li&gt;Leadership &amp;amp; Collaboration.&lt;/li&gt;&lt;/ul&gt;&lt;p&gt;Remote-first&lt;br&gt;cooperation.&lt;/p&gt;</description>
<pubDate>{pubdate}</pubDate><guid>https://djinni.co/jobs/850592-lead-platform-engineer/</guid><category>.NET</category><category/></item>
<item><title>A card with no description at all</title><link>https://djinni.co/jobs/850570-scala-team-lead/</link>
<description></description><pubDate>Mon, 31 Aug 2026 13:08:19 +0300</pubDate></item>
<item><title>Not a vacancy link at all</title><link>https://djinni.co/jobs/</link>
<description>&lt;p&gt;Ignored.&lt;/p&gt;</description></item>
</channel></rss>
"""

# A trimmed copy of the live Landing.Jobs feed (2026-09-30): **Atom**, ISO-8601 dates, the role in
# `<title>` with the company in `<author>`, and - the reason this fixture exists - the site's own
# `lj:` elements with **no `xmlns:lj` declared anywhere**, which is what makes the document
# ill-formed for a strict parser. `{published}`/`{older}` are filled in relative to now (see `iso`);
# the last two entries are the unusable cases (no description, no vacancy URL).
LANDINGJOBS_FEED_TEMPLATE = """<?xml version="1.0" encoding="UTF-8"?>
<feed xml:lang="en-US" xmlns="http://www.w3.org/2005/Atom">
  <id>https://landing.jobs/</id>
  <link rel="self" type="application/atom+xml" href="https://landing.jobs/feed"/>
  <title>Jobs @ Landing.jobs</title>
  <updated>{published}</updated>
  <entry>
    <id>https://landing.jobs/at/dashlane-pt/analytics-engineer-in-lisbon</id>
    <published>{published}</published>
    <updated>{published}</updated>
    <link rel="alternate" type="text/html" href="https://landing.jobs/at/dashlane-pt/analytics-engineer-in-lisbon?utm_campaign=landing+rss&amp;utm_source=rss"/>
    <title>Analytics Engineer</title>
    <content type="html"><![CDATA[<img class="logo" src="https://s3.eu-central-1.amazonaws.com/storage.landing.jobs/4hwvhwmox9wd" /><div class="offer-info">At Dashlane (Permanent), in Lisbon, Portugal<br />Expires at: 2027-03-02<br />Remote policy: Partial remote</div><div class="role-description"><p>Model the data &amp;amp; own the stack.</p><ul><li>SQL &amp; dbt</li><li>Python</li></ul></div>]]></content>
    <author>
      <name>Dashlane</name>
    </author>
    <lj:city>Lisbon</lj:city>
    <lj:country>Portugal</lj:country>
    <lj:salary/>
    <lj:job_type>Permanent</lj:job_type>
    <lj:category>Data</lj:category>
    <lj:location>
      <lj:city>Lisbon</lj:city>
      <lj:country>Portugal</lj:country>
    </lj:location>
  </entry>
  <entry>
    <id>https://landing.jobs/at/damia/uphill-health-senior-platform-engineer</id>
    <published>{older}</published>
    <updated>{older}</updated>
    <link rel="alternate" type="text/html" href="https://landing.jobs/at/damia/uphill-health-senior-platform-engineer?utm_medium=referral"/>
    <title>Uphill Health - Senior Platform Engineer</title>
    <content type="html"><![CDATA[<div class="offer-info">At Damia (Permanent), in Lisbon, Portugal<br />Expires at: 2027-05-12<br />Remote policy: Partial remote</div><div class="role-description"><p>Healthcare platform work.</p></div>]]></content>
    <author>
      <name>Damia</name>
    </author>
    <lj:salary>€60.000 - €70.000</lj:salary>
    <lj:location>
      <lj:city>Lisbon</lj:city>
      <lj:country>Portugal</lj:country>
    </lj:location>
  </entry>
  <entry>
    <id>https://landing.jobs/at/damia/dynamics-365</id>
    <published>{published}</published>
    <updated>{published}</updated>
    <link rel="alternate" type="text/html" href="https://landing.jobs/at/damia/dynamics-365"/>
    <title>Dynamics 365</title>
    <author>
      <name>Damia</name>
    </author>
  </entry>
  <entry>
    <id>https://landing.jobs/jobs</id>
    <published>{published}</published>
    <updated>{published}</updated>
    <link rel="alternate" type="text/html" href="https://landing.jobs/jobs"/>
    <title>Not a vacancy link at all</title>
    <content type="html"><![CDATA[<p>Ignored.</p>]]></content>
    <author>
      <name>Landing.Jobs</name>
    </author>
  </entry>
</feed>
"""

# The feeds a run sees in the tests: all published within the last day or three, so the age rule
# keeps them. The dates have to come from `rfc822`/`iso` - a literal would be judged by the rule too.
FEED = DOU_FEED.format(pubdate=rfc822(2))
DJINNI_FEED = DJINNI_FEED_TEMPLATE.format(pubdate=rfc822(1))
LANDINGJOBS_FEED = LANDINGJOBS_FEED_TEMPLATE.format(published=iso(1), older=iso(3))

# One fixture per source, keyed by the slug that source declares - the registry contract reads this.
FIXTURES = {"dou": FEED, "djinni": DJINNI_FEED, "landing-jobs": LANDINGJOBS_FEED}


def dou_cards(feed=FEED):
    """The DOU fixture as a run sees it: parsed by its site's parser, stamped with its slug."""
    collected = run.collect([(DOU_URL, feed)])
    assert collected.skipped_feeds == []
    return collected.vacancies


def test_the_title_is_split_into_role_company_location_and_salary():
    parts = dou.parse_title("Senior Full Stack .NET Engineer в Talmatic, $5000–6000, віддалено")
    assert parts == {
        "role": "Senior Full Stack .NET Engineer",
        "company": "Talmatic",
        "location": "віддалено",
        "salary": "$5000–6000",
    }
    # A title that does not follow the pattern keeps its whole text as the role.
    rough = dou.parse_title("A role without the marker")
    assert rough["role"] == "A role without the marker"
    assert rough["company"] == "" and rough["location"] == "" and rough["salary"] == ""


def test_the_vacancy_id_comes_from_the_link_and_matches_the_listing_page_space():
    assert (
        dou.external_id_from_link(
            "https://jobs.dou.ua/companies/talmatic/vacancies/374708/?utm_source=jobsrss"
        )
        == "374708"
    )
    assert dou.external_id_from_link("https://jobs.dou.ua/vacancies/") is None
    assert dou.external_id_from_link(None) is None


def test_the_description_becomes_plain_text_with_bullets_and_no_site_chrome():
    raw = ET.fromstring(FEED).find(".//item/description").text or ""
    text = dou.html_to_text(raw)
    assert "About the Role" in text
    assert "C# and AT&T cloud." in text, "both entity layers have to unescape"
    assert "• Design APIs" in text
    assert "<" not in text
    assert "Відгукнутись на вакансію" not in text, "the apply link is not part of the vacancy"
    assert "\n\n" in text


def test_parse_feed_skips_items_a_card_could_not_use():
    vacancies = dou.parse_feed(FEED)
    assert [vacancy["external_id"] for vacancy in vacancies] == ["374708", "361093"]
    first = vacancies[0]
    assert first["title"] == "Senior Full Stack .NET Engineer"
    assert first["company"] == "Talmatic"
    assert first["source_url"] == "https://jobs.dou.ua/companies/talmatic/vacancies/374708/"
    # The fixture dates itself relative to now (see `rfc822`), so assert the *age*, not the string.
    assert policy.published_age_days(first["published_at"]) == pytest.approx(2, abs=0.05)
    # A malformed feed yields nothing rather than raising: one bad feed must not stop a run.
    assert dou.parse_feed("<rss><channel><item>") == []
    assert dou.parse_feed("") == []


# --------------------------------------------------------------------------- #
# The registry: what "adding a feed" means, asserted instead of documented
# --------------------------------------------------------------------------- #


def test_every_parser_is_a_well_formed_source():
    """One `SOURCE` per site, with a slug the database accepts (`resumes_source_shape`)."""
    registry = sources.get_sources()
    assert {source.name for source in registry} == {"dou", "djinni", "landing-jobs"}, (
        "the slugs are the ones the browser scrape sends (`sourceForUrl`): renaming one would "
        "fork every card it already owns"
    )
    for source in registry:
        assert re.fullmatch(r"[a-z0-9][a-z0-9-]{1,31}", source.name), source.name
        assert source.hosts, f"{source.name} claims no host"
        assert callable(source.parse_feed)
        assert source.label, f"{source.name} needs a label for the logs and the dry run"


def test_a_feed_url_is_routed_by_host_and_the_registry_refuses_a_clash():
    assert sources.source_for_url(DOU_URL).name == "dou"
    assert sources.source_for_url(DJINNI_URL).name == "djinni"
    assert sources.source_for_url(LANDINGJOBS_URL).name == "landing-jobs"
    # A subdomain belongs to its site: DOU's feed lives on jobs.dou.ua.
    assert sources.source_for_url("https://www.djinni.co/jobs/rss/").name == "djinni"
    for unroutable in ("https://example.com/rss", "not a url", "", "https://[::1/rss"):
        assert sources.source_for_url(unroutable) is None

    # Two parsers on one slug would merge two sites into one card space; two on one host would
    # make routing depend on import order. Both are load-time errors, not run-time surprises.
    dou_source = FeedSource(name="dou", hosts=("dou.ua",), parse_feed=dou.parse_feed)
    with pytest.raises(ValueError):
        sources.validate((dou_source, FeedSource("dou", ("other.example",), dou.parse_feed)))
    with pytest.raises(ValueError):
        sources.validate((dou_source, FeedSource("other", ("dou.ua",), dou.parse_feed)))
    sources.validate((dou_source, FeedSource("other", ("other.example",), dou.parse_feed)))


def test_the_registry_is_discovered_once_and_can_be_dropped_for_a_test():
    """`get_sources()` caches discovery (one run = one look at the parsers); the hook clears it."""
    assert sources.get_sources() is sources.get_sources()
    sources.reset_sources_cache()
    try:
        assert [source.name for source in sources.get_sources()] == ["djinni", "dou", "landing-jobs"]
    finally:
        sources.reset_sources_cache()


def test_every_configured_feed_has_a_parser():
    """A URL nobody can parse would be refused by preflight - the suite refuses it first."""
    for url in config.SCOUT_FEEDS:
        assert sources.source_for_url(url) is not None, f"no parser claims {url}"


def test_every_source_has_a_fixture_and_returns_exactly_the_card_contract():
    """A site is not added until its parser has a fixture: the recipe, enforced by the suite."""
    assert set(FIXTURES) == {source.name for source in sources.get_sources()}
    for source in sources.get_sources():
        parsed = source.parse_feed(FIXTURES[source.name])
        assert parsed, f"{source.name}'s fixture produced no card"
        for vacancy in parsed:
            assert set(vacancy) == set(Vacancy.__annotations__), source.name
        # One broken feed must never stop a run, whatever shape the breakage has.
        assert source.parse_feed("") == []
        assert source.parse_feed("<rss><channel><item>") == []
        assert source.parse_feed("not xml at all") == []


# --------------------------------------------------------------------------- #
# Djinni - the second site, and the reason the registry exists
# --------------------------------------------------------------------------- #


def test_the_djinni_id_is_the_number_of_the_job_link():
    assert (
        djinni.external_id_from_link("https://djinni.co/jobs/850592-lead-platform-engineer/")
        == "850592"
    )
    assert djinni.external_id_from_link("https://djinni.co/jobs/850592/") == "850592"
    assert djinni.external_id_from_link("https://djinni.co/jobs/") is None
    assert djinni.external_id_from_link("https://djinni.co/companies/acme/") is None
    assert djinni.external_id_from_link(None) is None


def test_a_djinni_card_takes_its_role_from_the_title_and_leaves_what_the_feed_omits_empty():
    """Djinni's feed carries no company, salary or location - an empty field is the honest one."""
    (vacancy,) = djinni.parse_feed(DJINNI_FEED)
    assert vacancy["external_id"] == "850592"
    assert vacancy["title"] == "Lead Platform Engineer"
    assert vacancy["company"] == "" and vacancy["location"] == "" and vacancy["salary"] == ""
    assert vacancy["source_url"] == "https://djinni.co/jobs/850592-lead-platform-engineer/"
    assert policy.published_age_days(vacancy["published_at"]) == pytest.approx(1, abs=0.05)


def test_the_djinni_description_loses_both_entity_layers_and_keeps_its_paragraphs():
    (vacancy,) = djinni.parse_feed(DJINNI_FEED)
    text = vacancy["description_raw"]
    assert "About you" in text
    assert "5+ years with .NET and custom IT solutions;" in text, "&amp;nbsp; becomes a space"
    assert "Leadership & Collaboration." in text, "&amp;amp; has to unescape"
    assert "• 5+ years" in text
    assert "Remote-first\ncooperation." in text, "&lt;br&gt; becomes a line break"
    assert "<" not in text and "\u00a0" not in text


def test_a_djinni_item_without_a_description_or_a_job_link_is_skipped():
    """Two of the fixture's three items are unusable: no text, and no vacancy link."""
    assert [v["external_id"] for v in djinni.parse_feed(DJINNI_FEED)] == ["850592"]
    assert djinni.parse_feed("<rss><channel><item>") == []
    assert djinni.parse_feed("") == []


def test_an_item_may_carry_its_identity_only_in_the_guid():
    """`link` and `guid` are the same URL on Djinni; the guid is the documented identity."""
    item = ET.fromstring(
        "<item><title>Only a guid</title>"
        "<guid>https://djinni.co/jobs/850594-only-a-guid/</guid>"
        "<description>&lt;p&gt;Text.&lt;/p&gt;</description></item>"
    )
    parsed = djinni.parse_item(item)
    assert parsed is not None and parsed["external_id"] == "850594"
    assert parsed["source_url"] == "https://djinni.co/jobs/850594-only-a-guid/"


# --------------------------------------------------------------------------- #
# Landing.Jobs - the third site, and the first Atom feed
# --------------------------------------------------------------------------- #


def test_the_landingjobs_feed_parses_even_though_the_site_never_binds_its_lj_prefix():
    """Without the repair a strict parser stops at the first `lj:` element (live: `unbound prefix`)."""
    assert "xmlns:lj" not in LANDINGJOBS_FEED, "the fixture must keep the site's own bug"
    with pytest.raises(ET.ParseError):
        ET.fromstring(LANDINGJOBS_FEED)
    assert len(landingjobs.parse_feed(LANDINGJOBS_FEED)) == 2

    # A feed that does declare the prefix must survive the repair untouched.
    declared = LANDINGJOBS_FEED.replace("<feed ", '<feed xmlns:lj="http://landing.jobs/ns" ', 1)
    assert len(landingjobs.parse_feed(declared)) == 2


def test_the_landingjobs_id_is_the_vacancy_url_path():
    assert (
        landingjobs.external_id_from_url(
            "https://landing.jobs/at/damia/uphill-health-senior-platform-engineer"
        )
        == "/at/damia/uphill-health-senior-platform-engineer"
    )
    assert (
        landingjobs.external_id_from_url("https://landing.jobs/at/dashlane-pt/x/?utm_source=rss")
        == "/at/dashlane-pt/x"
    )
    for not_a_vacancy in ("https://landing.jobs/jobs", "https://landing.jobs/at/", None, ""):
        assert landingjobs.external_id_from_url(not_a_vacancy) is None


def test_a_landingjobs_card_takes_the_role_from_the_title_and_the_company_from_the_author():
    """The company is `<author><name>`: only 3 of the 56 live titles carry a " - " marker."""
    first, second = landingjobs.parse_feed(LANDINGJOBS_FEED)
    assert first["external_id"] == "/at/dashlane-pt/analytics-engineer-in-lisbon"
    assert first["title"] == "Analytics Engineer"
    assert first["company"] == "Dashlane"
    assert first["source_url"] == "https://landing.jobs/at/dashlane-pt/analytics-engineer-in-lisbon"
    assert first["location"] == "Lisbon, Portugal"
    assert first["salary"] == "", "an empty <lj:salary/> is no salary"
    assert policy.published_age_days(first["published_at"]) == pytest.approx(1, abs=0.05)

    # A title may name the client ("Uphill Health - ..."): it stays the title and the posting
    # company still comes from the author - nothing is split on the dash.
    assert second["title"] == "Uphill Health - Senior Platform Engineer"
    assert second["company"] == "Damia"
    assert second["salary"] == "€60.000 - €70.000"
    assert second["location"] == "Lisbon, Portugal", "the nested lj:location block is the fallback"


def test_the_landingjobs_description_keeps_the_postings_terms_and_loses_the_logo():
    first, _ = landingjobs.parse_feed(LANDINGJOBS_FEED)
    text = first["description_raw"]
    assert text.startswith("At Dashlane (Permanent), in Lisbon, Portugal")
    assert "Expires at: 2027-03-02" in text and "Remote policy: Partial remote" in text
    assert "Model the data & own the stack." in text, "the double-escaped entity has to unescape"
    assert "• SQL & dbt" in text
    assert "<" not in text and "logo" not in text, "the <img> loses its tag like any element"


def test_a_landingjobs_item_without_a_description_or_a_vacancy_url_is_skipped():
    """Two of the fixture's four entries are unusable: no `<content>`, and not a vacancy URL."""
    assert [v["external_id"] for v in landingjobs.parse_feed(LANDINGJOBS_FEED)] == [
        "/at/dashlane-pt/analytics-engineer-in-lisbon",
        "/at/damia/uphill-health-senior-platform-engineer",
    ]
    assert landingjobs.parse_feed("<feed><entry>") == []
    assert landingjobs.parse_feed('<?xml version="1.0"?><feed><entry/></feed>') == []


# --------------------------------------------------------------------------- #
# The age rule: a feed is a window, not a stream
# --------------------------------------------------------------------------- #


def test_the_age_comes_from_the_feeds_own_rfc822_date():
    """The offset is honoured, so a feed's own timezone cannot move a vacancy across the cutoff."""
    utc = policy.published_age_days("Mon, 28 Sep 2026 12:00:00 +0000", now=FIXED_NOW)
    plus3 = policy.published_age_days("Mon, 28 Sep 2026 12:00:00 +0300", now=FIXED_NOW)
    assert utc == pytest.approx(0, abs=0.001)
    assert plus3 - utc == pytest.approx(3 / 24, abs=0.001)

    # A date the feed never really stated is not an age: the policy must not invent one.
    for unusable in ("", None, "not a date", "Fri, 99 Sep 2026 12:00:00 +0000"):
        assert policy.published_age_days(unusable, now=FIXED_NOW) is None


def test_the_age_rule_reads_atom_dates_as_well_as_rss_ones():
    """Atom mandates ISO-8601: an RSS-only reader would leave every Atom card undated (i.e. kept)."""
    assert policy.published_age_days(iso(2, now=FIXED_NOW), now=FIXED_NOW) == pytest.approx(
        2, abs=0.001
    )
    assert policy.published_age_days("2026-09-28T12:00:00+03:00", now=FIXED_NOW) == pytest.approx(
        3 / 24, abs=0.001
    )
    # The ISO branch must not turn a date nobody stated into an age either.
    for unusable in ("2026-13-45", "29/09/2026 12:00", "not a date"):
        assert policy.published_age_days(unusable, now=FIXED_NOW) is None


def test_the_run_refuses_an_atom_vacancy_the_feed_dated_before_the_limit():
    """The date is read, so an old Landing.Jobs posting is refused rather than kept as undated."""
    old = LANDINGJOBS_FEED_TEMPLATE.format(published=iso(20), older=iso(21))
    collected = run.collect([(LANDINGJOBS_URL, old)])
    assert collected.skipped_feeds == []
    assert collected.stale == 2
    assert collected.vacancies == []


def test_the_policy_refuses_what_the_feed_dated_too_long_ago_and_keeps_the_rest():
    cards = [
        card("fresh", rfc822(2, now=FIXED_NOW)),
        card("cutoff", rfc822(7, now=FIXED_NOW)),  # exactly the limit: the test is `>`, so kept
        card("over-the-line", rfc822(8, now=FIXED_NOW)),
        card("month-old", rfc822(28, now=FIXED_NOW)),
        card("undated", ""),  # no date at all: kept, counted, never dropped silently
    ]
    selection = policy.select(cards, max_age_days=7, now=FIXED_NOW)
    assert [v["external_id"] for v in selection.kept] == ["fresh", "cutoff", "undated"]
    assert selection.stale == 2
    assert selection.undated == 1

    # 0 turns the rule off instead of refusing everything.
    everything = policy.select(cards, max_age_days=0, now=FIXED_NOW)
    assert len(everything.kept) == 5
    assert everything.stale == 0 and everything.undated == 1


def test_the_run_refuses_a_vacancy_the_feed_dated_before_the_limit(monkeypatch):
    """The rule itself: a 20-day-old posting is not even a card, an undated one still is."""
    old = DOU_FEED.format(pubdate=rfc822(20))
    collected = run.collect([(DOU_URL, old)])
    assert collected.stale == 1
    assert [v["external_id"] for v in collected.vacancies] == ["361093"], "the undated one stays"

    # The limit is configuration, read when the run runs.
    monkeypatch.setattr(config, "SCOUT_MAX_AGE_DAYS", 30)
    assert run.collect([(DOU_URL, old)]).stale == 0
    monkeypatch.setattr(config, "SCOUT_MAX_AGE_DAYS", 0)
    assert run.collect([(DOU_URL, old)]).stale == 0, "0 disables the rule"


def test_a_run_reports_the_age_rule_and_what_it_refused(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            monkeypatch.setattr(
                feeds,
                "fetch_all",
                lambda urls=None: [(DOU_URL, DOU_FEED.format(pubdate=rfc822(20)))],
            )
            monkeypatch.setattr(run.config, "SCOUT_USER_ID", "scout-user")
            monkeypatch.setattr(run.config, "SCOUT_NOTIFY", "none")

            assert run.main([]) == 0

            (row,) = db_module.get_db().list_process_runs()
            assert row["summary"]["max_age_days"] == 14
            assert row["summary"]["stale_dropped"] == 1
            assert row["summary"]["parsed"] == 1, "the stale card never reaches the board"
            assert [job["external_id"] for job in db_module.get_db().list_jobs()] == ["361093"]


# --------------------------------------------------------------------------- #
# The run: routing, the board writes, and "a scrape queues nothing"
# --------------------------------------------------------------------------- #


def test_collect_routes_each_feed_to_its_own_parser_and_stamps_the_source():
    collected = run.collect([(DOU_URL, FEED), (DJINNI_URL, DJINNI_FEED)])
    assert collected.skipped_feeds == []
    assert collected.stale == 0, "both fixtures are days old, not weeks"
    assert collected.undated == 1, "the DOU fixture's second item states no date"
    assert [(v["source"], v["external_id"]) for v in collected.vacancies] == [
        ("dou", "374708"),
        ("dou", "361093"),
        ("djinni", "850592"),
    ]
    assert collected.vacancies[0]["company"] == "Talmatic", "the DOU parser ran"
    assert collected.vacancies[-1]["company"] == "", "the Djinni parser ran"


def test_the_same_number_from_two_sites_is_two_vacancies():
    """The key is per site: DOU's 848944 and Djinni's 848944 are different vacancies."""
    dou_feed = FEED.replace("374708", "848944")
    djinni_feed = DJINNI_FEED.replace("850592", "848944")
    vacancies = run.collect([(DOU_URL, dou_feed), (DJINNI_URL, djinni_feed)]).vacancies
    assert [
        (v["source"], v["external_id"]) for v in vacancies if v["external_id"] == "848944"
    ] == [("dou", "848944"), ("djinni", "848944")]


def test_collect_skips_a_feed_whose_host_no_parser_claims():
    """Never guess a site: preflight refuses such a config, and this is the second half."""
    collected = run.collect([("https://example.com/rss", FEED)])
    assert collected.vacancies == []
    assert collected.skipped_feeds == ["https://example.com/rss"]
    assert run.source_breakdown([]) == ""


def test_the_intake_creates_cards_in_scraped_and_remembers_them():
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            vacancies = dou_cards()
            fresh = scout_store.new_vacancies(vacancies, "v1")
            assert len(fresh) == 2, "an empty board has nothing to dedupe against"

            created = scout_store.create_cards(fresh, "scout-user", "v1")
            assert len(created) == 2

            row = db_module.get_db().get_job(created[0]["job_id"])
            assert row["status"] == "submitted", "claimable, so the drag's message adopts it"
            assert row["source"] == "dou"
            assert row["user_id"] == "scout-user"
            assert row["description_raw"].startswith("About the Role")

            # The next run of the same feeds creates nothing - the dedupe is the point.
            assert scout_store.new_vacancies(dou_cards(), "v1") == []


def test_a_handled_card_counts_as_known_too():
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            created = scout_store.create_cards(dou_cards(), "scout-user", "v1")
            db_module.get_db().update_job(created[0]["job_id"], status="failed")
            # Whatever the status (a failure, or a card the operator refused): re-running the
            # intake must not duplicate or reopen it.
            assert scout_store.new_vacancies(dou_cards(), "v1") == []


def test_a_card_on_the_board_of_another_site_does_not_hide_this_one():
    """The dedupe asks the board about one site at a time - that is what the slug is for."""
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            # The board already holds Djinni's 374708; DOU's 374708 is still a new card.
            djinni_card = FIXTURES["djinni"].replace("850592", "374708")
            vacancies = run.collect([(DJINNI_URL, djinni_card)]).vacancies
            scout_store.create_cards(scout_store.new_vacancies(vacancies, "v1"), "scout-user", "v1")

            fresh = scout_store.new_vacancies(dou_cards(), "v1")
            assert [v["external_id"] for v in fresh] == ["374708", "361093"]


def test_the_scout_never_queues_anything():
    """The reason it can run every 30 minutes: it costs no Gemini call and no message."""
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            scout_store.create_cards(dou_cards(), "scout-user", "v1")
            assert get_queue().depth() == 0, "no tailoring message"
            assert get_queue(spec=cover_queue_spec()).depth() == 0, "no cover-letter request"


def test_the_dry_run_writes_nothing(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            # No network: the feed body is injected where the transport would fetch it.
            monkeypatch.setattr(feeds, "fetch_all", lambda urls=None: [(DOU_URL, FEED)])
            monkeypatch.setattr(run.config, "SCOUT_USER_ID", "scout-user")
            monkeypatch.setattr(run.config, "SCOUT_NOTIFY", "none")

            assert run.main(["--dry-run"]) == 0

            assert db_module.get_db().list_jobs() == [], "a dry run must not create cards"
            assert get_queue().depth() == 0
            # "Writes nothing" includes the process ledger: a dry run is not a run.
            assert db_module.get_db().list_process_runs() == []


def test_a_run_over_two_sites_creates_one_card_each_with_its_own_slug(monkeypatch):
    """The point of the registry: two feeds, two parsers, two slugs, one run."""
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            monkeypatch.setattr(
                feeds, "fetch_all", lambda urls=None: [(DOU_URL, FEED), (DJINNI_URL, DJINNI_FEED)]
            )
            monkeypatch.setattr(run.config, "SCOUT_USER_ID", "scout-user")
            monkeypatch.setattr(run.config, "SCOUT_NOTIFY", "none")

            assert run.main([]) == 0

            rows = {
                (row["source"], row["external_id"]): row
                for row in db_module.get_db().list_jobs()
            }
            assert set(rows) == {("dou", "374708"), ("dou", "361093"), ("djinni", "850592")}
            assert rows[("dou", "374708")]["company"] == "Talmatic"
            assert rows[("djinni", "850592")]["description_raw"].startswith("About you")

            (ledger,) = db_module.get_db().list_process_runs()
            assert ledger["summary"]["sources"] == "djinni:1,dou:2"
            assert "feeds_skipped" not in ledger["summary"]


def test_a_run_records_itself_in_the_process_ledger(monkeypatch):
    """The board's Processes window shows the intake's *runs*, not only its cards."""
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            monkeypatch.setattr(feeds, "fetch_all", lambda urls=None: [(DOU_URL, FEED)])
            monkeypatch.setattr(run.config, "SCOUT_USER_ID", "scout-user")
            monkeypatch.setattr(run.config, "SCOUT_NOTIFY", "none")

            assert run.main([]) == 0

            (row,) = db_module.get_db().list_process_runs()
            assert row["process"] == "feed-parser"
            assert row["trigger"] == "schedule"
            assert row["status"] == "ok"
            assert row["finished_at"] is not None
            assert row["summary"] == {
                "feeds": 5,
                "notify": "none",
                "feeds_ok": 1,
                "parsed": 2,
                "sources": "dou:2",
                "max_age_days": 14,
                "new_cards": 2,
                "created_cards": 2,
                "notified": 0,
            }


def test_the_startup_run_is_recorded_as_its_own_trigger(monkeypatch):
    """`--trigger startup` is the deploy's run (`infra/charts/cv-tailoring-scout` posts the same Job as
    a Helm hook): the window has to be able to tell the boot run from a CronJob slot."""
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            monkeypatch.setattr(feeds, "fetch_all", lambda urls=None: [(DOU_URL, FEED)])
            monkeypatch.setattr(run.config, "SCOUT_USER_ID", "scout-user")
            monkeypatch.setattr(run.config, "SCOUT_NOTIFY", "none")

            assert run.main(["--trigger", "startup"]) == 0

            (row,) = db_module.get_db().list_process_runs()
            assert row["trigger"] == "startup"
            assert row["status"] == "ok"
            assert row["summary"]["created_cards"] == 2


def test_the_trigger_vocabulary_is_the_databases():
    """`--trigger` and the `process_runs.trigger` CHECK (`apps/worker/utils/db.py`) are one vocabulary: a
    word the column rejects must not be accepted here, and the CronJob's own command - no flag -
    stays a scheduled slot."""
    with pytest.raises(SystemExit):
        run.parse_args(["--trigger", "cron"])
    assert run.parse_args(["--trigger", "startup"]).trigger == "startup"
    assert run.parse_args([]).trigger == "schedule"


def test_a_run_without_a_feed_is_an_error_not_an_empty_week(monkeypatch):
    """A CronJob has to be able to tell "every feed is down" from "nothing new"."""
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            monkeypatch.setattr(feeds, "fetch_all", lambda urls=None: [])
            monkeypatch.setattr(run.config, "SCOUT_USER_ID", "scout-user")
            assert run.main([]) == 1

            # ... and the ledger says the same thing, so the window can too.
            (row,) = db_module.get_db().list_process_runs()
            assert row["status"] == "failed"
            assert row["error"] == "no feed answered"


def test_a_configured_feed_no_parser_can_read_stops_the_run(monkeypatch):
    """A URL the registry cannot route is a configuration error, not a card to guess at."""
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            monkeypatch.setattr(run.config, "SCOUT_USER_ID", "scout-user")
            monkeypatch.setattr(run.config, "SCOUT_FEEDS", ["https://example.com/rss"])

            assert run.main([]) == 1

            (row,) = db_module.get_db().list_process_runs()
            assert row["status"] == "failed"
            assert "no parser claims the host" in row["error"]


def test_the_intake_refuses_to_write_as_an_unknown_account(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            monkeypatch.setattr(run.config, "SCOUT_USER_ID", "")
            # Preflight refuses: a row owned by nobody would look fine on the board while the
            # operator's drag could not adopt it.
            assert run.main(["--dry-run"]) == 1


def test_the_telegram_message_is_plain_and_says_where_it_came_from():
    vacancy = run.collect([(DOU_URL, FEED)]).vacancies[0]
    message = telegram.build_message(vacancy, "dou")
    assert "Senior Full Stack .NET Engineer" in message
    assert "Talmatic" in message
    assert "$5000–6000" in message
    assert vacancy["source_url"] in message
    assert "source: dou" in message


def test_telegram_stays_silent_without_configuration(monkeypatch):
    monkeypatch.setattr(telegram.config, "SCOUT_TELEGRAM_TOKEN", "")
    monkeypatch.setattr(telegram.config, "SCOUT_TELEGRAM_CHAT_ID", "")
    # No token, no network call, no exception: the card is the durable part of the run.
    assert telegram.send("hello") is False


def test_the_token_never_reaches_a_log_line():
    assert telegram._redact("https://api.telegram.org/bot123:abc/sendMessage", "123:abc") == (
        "https://api.telegram.org/bot<token>/sendMessage"
    )
