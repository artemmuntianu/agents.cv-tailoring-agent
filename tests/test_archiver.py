"""The inactivity sweep: which cards it refuses, what it refuses to do, and what it records.

Hermetic - the store is injected (`FakeBoard`), so the *policy* is asserted without a
database. The SQL behind `list_inactive_cards` / `archive_card` is pinned by the
`TEST_DATABASE_URL`-gated tests in `tests/test_postgres_store.py`.
"""

import tempfile

import pytest

import config
from archiver import run as archiver
from tests.helpers import isolated_config
from utils import db as db_module
from utils.db import LocalDb


def card(job_id, stage="applied", **overrides):
    return {
        "job_id": job_id,
        "external_id": job_id.split("-")[0],
        "source": "dou",
        "title": f"Role {job_id}",
        "company": "Acme",
        "stage": stage,
        **overrides,
    }


class FakeBoard(LocalDb):
    """`LocalDb` with a Postgres-shaped board: the real ledger, stubbed board queries.

    Subclassing the file backend is what keeps this hermetic - the run records land in the
    isolated JSON file, so one test can assert on the ledger *and* on the sweep.
    """

    backend = "postgres"

    def __init__(self, cards=(), failing=()):
        super().__init__()
        self.cards = list(cards)
        self.failing = set(failing)
        self.archived = []
        self.query = None

    def list_inactive_cards(self, stages, older_than_days, limit=100):
        self.query = {
            "stages": tuple(stages),
            "older_than_days": int(older_than_days),
            "limit": int(limit),
        }
        return self.cards[: int(limit)]

    def archive_card(self, job_id, actor, reason):
        if job_id in self.failing:
            raise RuntimeError(f"the board refused to archive {job_id}")
        self.archived.append((job_id, actor, reason))
        return True


def board(monkeypatch, cards=(), failing=()):
    """Wire a `FakeBoard` in as *the* store and return it."""
    store = FakeBoard(cards=cards, failing=failing)
    monkeypatch.setattr(db_module, "get_db", lambda backend=None: store)
    return store


def test_the_sweep_refuses_every_stale_card_with_the_configured_actor_and_reason(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            store = board(monkeypatch, cards=[card("848944-1"), card("848944-2")])

            assert archiver.main([]) == 0

            assert store.archived == [
                ("848944-1", "Company", "No response"),
                ("848944-2", "Company", "No response"),
            ]
            # The policy is the config's, and it reaches the query as-is.
            assert store.query == {"stages": ("applied",), "older_than_days": 10, "limit": 50}

            (row,) = store.list_process_runs()
            assert row["process"] == "auto-archiver"
            assert row["trigger"] == "schedule"
            assert row["status"] == "ok"
            assert row["summary"]["refused"] == 2
            assert row["summary"]["after_days"] == 10
            assert row["summary"]["reason"] == "No response"


def test_nothing_to_do_is_a_clean_run(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            store = board(monkeypatch)

            assert archiver.main([]) == 0

            assert store.archived == []
            (row,) = store.list_process_runs()
            assert row["status"] == "ok"
            assert row["summary"]["candidates"] == 0
            assert row["summary"]["refused"] == 0


def test_a_dry_run_writes_nothing_at_all(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            store = board(monkeypatch, cards=[card("848944-1")])

            assert archiver.main(["--dry-run"]) == 0

            assert store.archived == [], "a dry run must not refuse anything"
            assert store.list_process_runs() == [], "and must not write a ledger row"



def test_one_failing_card_does_not_end_the_sweep_and_the_run_says_so(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            store = board(monkeypatch, cards=[card("a-1"), card("b-1")], failing={"a-1"})

            assert archiver.main([]) == 1, "a partial sweep is not a clean run"

            assert store.archived == [("b-1", "Company", "No response")]
            (row,) = store.list_process_runs()
            assert row["status"] == "failed"
            assert row["summary"]["failed"] == 1
            assert "1 of 2" in row["error"]


def test_the_clock_the_stages_and_the_cap_come_from_configuration(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            monkeypatch.setattr(config, "AUTO_ARCHIVE_STAGES", ["negotiating", "applied"])
            monkeypatch.setattr(config, "AUTO_ARCHIVE_AFTER_DAYS", 3)
            monkeypatch.setattr(config, "AUTO_ARCHIVE_MAX_PER_RUN", 1)
            monkeypatch.setattr(config, "AUTO_ARCHIVE_REASON", "Radio silence")
            store = board(monkeypatch, cards=[card("a-1"), card("b-1")])

            assert archiver.main([]) == 0

            assert store.query == {
                "stages": ("negotiating", "applied"),
                "older_than_days": 3,
                "limit": 1,
            }
            assert store.archived == [("a-1", "Company", "Radio silence")]


def test_the_cli_overrides_the_sweep_window(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            store = board(monkeypatch)

            assert archiver.main(["--stages", "applied,negotiating", "--after-days", "5"]) == 0

            assert store.query["stages"] == ("applied", "negotiating")
            assert store.query["older_than_days"] == 5


def test_a_hand_run_is_recorded_as_manual(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            store = board(monkeypatch)

            assert archiver.main(["--trigger", "manual"]) == 0

            (row,) = store.list_process_runs()
            assert row["trigger"] == "manual"


def test_the_json_backend_refuses_to_run(monkeypatch):
    """The board's columns are Postgres tables: a sweep that cannot write them is not a sweep."""
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            store = LocalDb()
            monkeypatch.setattr(db_module, "get_db", lambda backend=None: store)

            assert archiver.main([]) == 1

            (row,) = store.list_process_runs()
            assert row["status"] == "failed"
            assert "postgres" in row["error"], "the message has to say what to do"
            assert row["summary"] is None, "the run never got as far as a policy"


def test_a_typo_in_the_configuration_or_the_actor_fails_the_run(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            monkeypatch.setattr(config, "AUTO_ARCHIVE_STAGES", ["appliedd"])
            store = board(monkeypatch, cards=[card("a-1")])

            assert archiver.main([]) == 1
            assert store.archived == []
            assert store.query is None, "the sweep never reached the board"
            (row,) = store.list_process_runs()
            assert row["status"] == "failed"
            assert "unknown column" in row["error"]

            monkeypatch.setattr(config, "AUTO_ARCHIVE_STAGES", ["applied"])
            monkeypatch.setattr(config, "AUTO_ARCHIVE_ACTOR", "Recruiter")
            assert archiver.main([]) == 1

            monkeypatch.setattr(config, "AUTO_ARCHIVE_ACTOR", "Candidate")
            monkeypatch.setattr(config, "AUTO_ARCHIVE_REASON", "   ")
            assert archiver.main([]) == 1

            monkeypatch.setattr(config, "AUTO_ARCHIVE_AFTER_DAYS", 0)
            monkeypatch.setattr(config, "AUTO_ARCHIVE_REASON", "No response")
            assert archiver.main([]) == 1


def test_the_policy_helpers_are_pure_and_loud():
    assert archiver.parse_stages(["applied", " applied "]) == ("applied", "applied")
    assert archiver.validate_refusal("Company", "No   response") == ("Company", "No response")
    assert archiver.validate_refusal("Candidate", "Withdrawn") == ("Candidate", "Withdrawn")

    for bad in ("", "  ", "x" * 501):
        with pytest.raises(ValueError):
            archiver.validate_refusal("Company", bad)
    with pytest.raises(ValueError):
        archiver.validate_refusal("Recruiter", "No response")
    with pytest.raises(ValueError):
        archiver.parse_stages(["appliedd"])
