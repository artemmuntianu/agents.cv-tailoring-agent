"""Cover-letter generation and its queue (hermetic: no Gemini, no broker, no volume).

What is worth pinning here: the prompt may only use facts the CV and the vacancy state, and
the four delivery outcomes the worker reports to the broker - written, duplicate, deferred on
quota, dead-lettered when there is nothing to write from.
"""

import tempfile
from unittest import mock

import cover as cover_worker
from agent import cover as cover_module
from agent import gemini as gemini_module
from agent.contracts import CoverLetterMessage
from tests.helpers import SAMPLE_CANDIDATE, SAMPLE_CV_DATA, SAMPLE_JD, isolated_config
from utils import db as db_module
from utils.messaging import Delivery, Outcome, cover_queue_spec, get_queue
from utils.retry import RetryLater


def job_row(job_id="cover-1", **overrides):
    row = {
        "job_id": job_id,
        "user_id": "u-1",
        "external_id": "900123",
        "source": "dou",
        "title": "Senior .NET Engineer",
        "company": "ACME",
        "source_url": "https://jobs.dou.ua/companies/acme/vacancies/900123/",
        "description_raw": "About the role\nWe need C#, .NET 8 and PostgreSQL.",
        "cv_version": "v1",
        "status": "submitted",
        "attempts": 0,
    }
    row.update(overrides)
    return row


def fake_client(monkeypatch):
    """Give the worker a throwaway client, with no API key anywhere in sight.

    `run_cover_letter` asks `agent.gemini.client()` *before* it calls the model call, so patching
    only `_call_gemini_cover_letter` still builds a real `genai.Client` - which raises "No API key
    was provided" on CI, where there is no `.env` and no secret. That is how four hermetic tests
    passed on a developer machine (whose `.env` carries a key) and dead-lettered on every CI run
    (2026-09-29).
    """
    monkeypatch.setattr(gemini_module, "client", lambda: mock.Mock())


def fake_letter(monkeypatch, letter="Hello,\n\nI fit this role.\n\nBest regards,\nJane Doe"):
    """Replace the one Gemini call and record the prompts it was asked with."""
    prompts = []
    fake_client(monkeypatch)

    def call(client, prompt):
        prompts.append(prompt)
        return cover_module.CoverLetter(cover_letter=letter)

    monkeypatch.setattr(cover_module, "_call_gemini_cover_letter", call)
    return prompts


def request(job_id="cover-1"):
    return Delivery(payload=CoverLetterMessage(job_id=job_id).model_dump())


# --- the prompt contract --------------------------------------------------- #


def test_the_prompt_carries_the_vacancy_and_the_cv_facts():
    prompt = cover_module.build_prompt(
        "We need C#, .NET 8 and PostgreSQL.",
        SAMPLE_CV_DATA,
        title="Senior .NET Engineer",
        company="ACME",
    )
    assert "We need C#, .NET 8 and PostgreSQL." in prompt
    assert "TITLE: Senior .NET Engineer" in prompt
    assert "COMPANY: ACME" in prompt
    # The letter may only repeat what the CV says...
    assert "Jane Doe" in prompt
    assert "Cut report generation time by 80%." in prompt
    # ...and the prompt forbids inventing anything else.
    assert "Never invent" in prompt
    assert "no markdown" in prompt
    # Live lesson: the model returned everything as one paragraph until the prompt said so.
    assert "separated by a blank line" in prompt
    # Live lesson (2026-09-26): the master CV has no NAME line, so a prompt that demanded a
    # signature produced "Best regards, Senior Software Engineer" - a title signed as a person.
    assert "if and only if" in prompt
    assert "Never sign with a job title" in prompt
    assert "standard language level" in prompt


def test_the_digest_omits_facts_the_cv_does_not_have():
    # No `name` in the header: no NAME line, so the prompt's signature rule has nothing to use
    # and the model signs with "Best regards," alone.
    digest = cover_module.cv_digest({"header": {"title": "Senior Software Engineer"}})
    assert "NAME:" not in digest
    assert "HEADLINE: Senior Software Engineer" in digest


def test_the_digest_leaves_the_projects_out():
    """The projects block is tailoring context (SUMMARY/SKILLS), not letter material."""
    digest = cover_module.cv_digest(SAMPLE_CV_DATA)
    assert SAMPLE_CV_DATA["personal_projects"][0]["heading"] not in digest
    assert "PERSONAL PROJECTS" not in digest


def test_the_prompt_carries_the_candidate_facts():
    prompt = cover_module.build_prompt(
        SAMPLE_JD,
        SAMPLE_CV_DATA,
        title="Senior .NET Engineer",
        company="ACME",
        candidate=SAMPLE_CANDIDATE,
    )
    assert "CANDIDATE FACTS" in prompt
    assert "ENGLISH LEVEL: B2 (Upper-Intermediate)" in prompt
    assert "STANDING ANSWER - Redis and RabbitMQ experience" in prompt
    # Ground truth for experience, never letter material: the prompt says so explicitly.
    assert "What a letter must never say" in prompt
    # A fresh operator has no row at all - that is a legitimate state, not an error.
    assert "(no candidate facts stored)" in cover_module.build_prompt(SAMPLE_JD, SAMPLE_CV_DATA)


def test_the_digest_tolerates_a_missing_model_and_a_pydantic_one():
    from agent.contracts import CvData

    assert cover_module.cv_digest(None) == ""
    # The JSON dict and the pydantic model have to behave the same.
    model = CvData.model_validate(SAMPLE_CV_DATA)
    assert cover_module.cv_digest(model) == cover_module.cv_digest(SAMPLE_CV_DATA)


# --- delivery outcomes ----------------------------------------------------- #


def test_handle_delivery_writes_the_letter(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            db_module.get_db().upsert_job(job_row())
            prompts = fake_letter(monkeypatch)

            result = cover_worker.handle_delivery(request())

            assert result.outcome == Outcome.ACK
            stored = db_module.get_db().get_cover_letter("cover-1")
            assert stored["status"] == cover_worker.COVER_COMPLETED
            assert stored["text"].startswith("Hello,")
            assert stored["attempts"] == 1
            assert stored["model"]
            # The prompt is assembled here from the row + the master CV, not passed in.
            assert "Cut report generation time by 80%." in prompts[0]


def test_a_redelivery_is_acked_without_calling_gemini(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            db_module.get_db().upsert_job(job_row())
            fake_letter(monkeypatch)
            cover_worker.handle_delivery(request())

            prompts = fake_letter(monkeypatch)
            again = cover_worker.handle_delivery(request())

            assert again.outcome == Outcome.ACK
            assert again.reason == "duplicate"
            assert prompts == [], "a duplicate must not pay for Gemini twice"


def test_a_regeneration_is_a_new_request(monkeypatch):
    """The board resets the row to `queued` for a new letter, so `queued` is a genuine
    request and only `completed` counts as a duplicate."""
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            store = db_module.get_db()
            store.upsert_job(job_row())
            fake_letter(monkeypatch, letter="first")
            cover_worker.handle_delivery(request())

            store.upsert_cover_letter("cover-1", cover_worker.COVER_QUEUED)
            prompts = fake_letter(monkeypatch, letter="second")
            result = cover_worker.handle_delivery(request())

            assert result.outcome == Outcome.ACK
            assert prompts, "a regeneration must call Gemini again"
            assert store.get_cover_letter("cover-1")["text"] == "second"


def test_a_removed_vacancy_is_acked(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            prompts = fake_letter(monkeypatch)
            result = cover_worker.handle_delivery(request())

            assert result.outcome == Outcome.ACK
            assert result.reason == "vacancy gone"
            assert prompts == []


def test_a_vacancy_without_a_description_is_dead_lettered(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            db_module.get_db().upsert_job(job_row(description_raw=None))
            prompts = fake_letter(monkeypatch)

            result = cover_worker.handle_delivery(request())

            assert result.outcome == Outcome.DEAD_LETTER
            stored = db_module.get_db().get_cover_letter("cover-1")
            assert stored["status"] == cover_worker.COVER_FAILED
            assert prompts == []


def test_quota_exhaustion_defers_and_keeps_the_request(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            db_module.get_db().upsert_job(job_row())
            fake_client(monkeypatch)

            def exhausted(client, prompt):
                raise RetryLater("daily quota", delay_seconds=1800)

            monkeypatch.setattr(cover_module, "_call_gemini_cover_letter", exhausted)
            result = cover_worker.handle_delivery(request())

            assert result.outcome == Outcome.RETRY_LATER
            assert result.delay_seconds == 1800
            # Still `queued`, never `failed`: the request is not lost.
            stored = db_module.get_db().get_cover_letter("cover-1")
            assert stored["status"] == cover_worker.COVER_QUEUED


# --- the queue itself ------------------------------------------------------ #


def test_the_two_queues_never_share_storage():
    """A cover-letter consumer must not eat tailoring messages (or the other way round)."""
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            task_queue = get_queue()
            cover_queue = get_queue(spec=cover_queue_spec())

            assert task_queue is not cover_queue
            assert cover_queue.base_dir != task_queue.base_dir

            cover_queue.publish({"job_id": "cover-1"})
            assert cover_queue.depth() == 1
            assert task_queue.depth() == 0
