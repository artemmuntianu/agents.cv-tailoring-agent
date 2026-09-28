"""The scout: feed parsing, board-scoped dedupe, and "a scrape queues nothing".

Hermetic - the feed is a fixture, the store is the file backend and Telegram is never called.
"""

import tempfile
import xml.etree.ElementTree as ET

import pytest

from scout import dou, feeds, run, telegram
from scout import store as scout_store
from tests.helpers import isolated_config
from utils import db as db_module
from utils.messaging import cover_queue_spec, get_queue

# A trimmed copy of the live feed (2026-09-26): the description is escaped HTML, the entity is
# double-escaped (`&amp;amp;`), the link carries the utm marker, and the description ends with
# the site's own apply link.
FEED = """<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>Вакансії</title>
<item>
  <title>Senior Full Stack .NET Engineer в Talmatic, $5000–6000, віддалено</title>
  <link>https://jobs.dou.ua/companies/talmatic/vacancies/374708/?utm_source=jobsrss</link>
  <description>&lt;p&gt;&lt;strong&gt;About the Role&lt;/strong&gt;&lt;/p&gt;&lt;p&gt;We use &lt;em&gt;C#&lt;/em&gt; and AT&amp;amp;T cloud.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Design APIs&lt;/li&gt;&lt;li&gt;Own delivery&lt;/li&gt;&lt;/ul&gt;
&lt;div&gt;&lt;a href="https://jobs.dou.ua/x"&gt;Відгукнутись на вакансію&lt;/a&gt;&lt;/div&gt;</description>
  <pubDate>Thu, 17 Sep 2026 15:11:24 +0300</pubDate>
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
    assert first["published_at"].startswith("Thu, 17 Sep 2026")
    # A malformed feed yields nothing rather than raising: one bad feed must not stop a run.
    assert dou.parse_feed("<rss><channel><item>") == []
    assert dou.parse_feed("") == []


def test_collect_deduplicates_across_feeds():
    vacancies = run.collect([("a", FEED), ("b", FEED)])
    assert [vacancy["external_id"] for vacancy in vacancies] == ["374708", "361093"]


def test_the_intake_creates_cards_in_scraped_and_remembers_them():
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            vacancies = dou.parse_feed(FEED)
            fresh = scout_store.new_vacancies(vacancies, "dou", "v1")
            assert len(fresh) == 2, "an empty board has nothing to dedupe against"

            created = scout_store.create_cards(fresh, "dou", "scout-user", "v1")
            assert len(created) == 2

            row = db_module.get_db().get_job(created[0]["job_id"])
            assert row["status"] == "submitted", "claimable, so the drag's message adopts it"
            assert row["source"] == "dou"
            assert row["user_id"] == "scout-user"
            assert row["description_raw"].startswith("About the Role")

            # The next run of the same feeds creates nothing - the dedupe is the point.
            assert scout_store.new_vacancies(dou.parse_feed(FEED), "dou", "v1") == []


def test_a_handled_card_counts_as_known_too():
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            vacancies = dou.parse_feed(FEED)
            created = scout_store.create_cards(
                scout_store.new_vacancies(vacancies, "dou", "v1"), "dou", "scout-user", "v1"
            )
            db_module.get_db().update_job(created[0]["job_id"], status="failed")
            # Whatever the status (a failure, or a card the operator refused): re-running the
            # intake must not duplicate or reopen it.
            assert scout_store.new_vacancies(dou.parse_feed(FEED), "dou", "v1") == []


def test_the_scout_never_queues_anything():
    """The reason it can run every 30 minutes: it costs no Gemini call and no message."""
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            vacancies = dou.parse_feed(FEED)
            scout_store.create_cards(
                scout_store.new_vacancies(vacancies, "dou", "v1"), "dou", "scout-user", "v1"
            )
            assert get_queue().depth() == 0, "no tailoring message"
            assert get_queue(spec=cover_queue_spec()).depth() == 0, "no cover-letter request"


def test_the_dry_run_writes_nothing(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            # No network: the feed body is injected where the transport would fetch it.
            monkeypatch.setattr(feeds, "fetch_all", lambda urls=None: [("fixture", FEED)])
            monkeypatch.setattr(run.config, "SCOUT_USER_ID", "scout-user")
            monkeypatch.setattr(run.config, "SCOUT_NOTIFY", "none")

            assert run.main(["--dry-run"]) == 0

            assert db_module.get_db().list_jobs() == [], "a dry run must not create cards"
            assert get_queue().depth() == 0
            # "Writes nothing" includes the process ledger: a dry run is not a run.
            assert db_module.get_db().list_process_runs() == []


def test_a_run_records_itself_in_the_process_ledger(monkeypatch):
    """The board's Processes window shows the intake's *runs*, not only its cards."""
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            monkeypatch.setattr(feeds, "fetch_all", lambda urls=None: [("fixture", FEED)])
            monkeypatch.setattr(run.config, "SCOUT_USER_ID", "scout-user")
            monkeypatch.setattr(run.config, "SCOUT_NOTIFY", "none")

            assert run.main([]) == 0

            (row,) = db_module.get_db().list_process_runs()
            assert row["process"] == "feed-parser"
            assert row["trigger"] == "schedule"
            assert row["status"] == "ok"
            assert row["finished_at"] is not None
            assert row["summary"] == {
                "feeds": 3,
                "notify": "none",
                "feeds_ok": 1,
                "parsed": 2,
                "new_cards": 2,
                "created_cards": 2,
                "notified": 0,
            }


def test_the_startup_run_is_recorded_as_its_own_trigger(monkeypatch):
    """`--trigger startup` is the deploy's run (`charts/cv-tailoring-scout` posts the same Job as
    a Helm hook): the window has to be able to tell the boot run from a CronJob slot."""
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            monkeypatch.setattr(feeds, "fetch_all", lambda urls=None: [("fixture", FEED)])
            monkeypatch.setattr(run.config, "SCOUT_USER_ID", "scout-user")
            monkeypatch.setattr(run.config, "SCOUT_NOTIFY", "none")

            assert run.main(["--trigger", "startup"]) == 0

            (row,) = db_module.get_db().list_process_runs()
            assert row["trigger"] == "startup"
            assert row["status"] == "ok"
            assert row["summary"]["created_cards"] == 2


def test_the_trigger_vocabulary_is_the_databases():
    """`--trigger` and the `process_runs.trigger` CHECK (`utils/db.py`) are one vocabulary: a
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


def test_the_intake_refuses_to_write_as_an_unknown_account(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            monkeypatch.setattr(run.config, "SCOUT_USER_ID", "")
            # Preflight refuses: a row owned by nobody would look fine on the board while the
            # operator's drag could not adopt it.
            assert run.main(["--dry-run"]) == 1


def test_the_telegram_message_is_plain_and_says_where_it_came_from():
    vacancy = dou.parse_feed(FEED)[0]
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
