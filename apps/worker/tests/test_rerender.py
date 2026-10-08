"""The *Update docx* worker and its queue (hermetic: no LibreOffice, no broker, no volume).

What is worth pinning here: the uploaded bytes are the deliverable (the card is repointed at the
new pair, in place, so every existing link keeps working), a redelivery of an already-rendered
upload costs nothing, a *second* upload does render again, and every broken row is refused instead
of retried forever.
"""

import os
import tempfile

import rerender as rerender_worker
from agent.contracts import RerenderMessage
from tests.helpers import SAMPLE_CANDIDATE, isolated_config, seed_candidate
from utils import db as db_module
from utils.messaging import Delivery, Outcome, get_queue, rerender_queue_spec

# Not a real DOCX on purpose: the worker never parses the file, LibreOffice does - and the test
# asserts the bytes that reach the converter (and the volume) are exactly the uploaded ones.
UPLOAD = b"PK\x03\x04 hand-edited deliverable"


def job_row(job_id="rerender-1", **overrides):
    row = {
        "job_id": job_id,
        "user_id": "u-1",
        "external_id": "900123",
        "source": "dou",
        "title": "Senior .NET Engineer",
        "company": "ACME",
        "cv_version": "v1",
        "status": "completed",
        # The board only offers the button for a card that has a deliverable, which is also this
        # worker's own guard against rendering into a card that never went through tailoring.
        "docx_path": "/data/output/900123.docx",
        "pdf_url": "/data/output/900123.pdf",
    }
    row.update(overrides)
    return row


def fake_render(monkeypatch, failure=None):
    """Stand in for LibreOffice: record what it was handed and write a stub PDF.

    The bytes are read *here*, inside the call: the worker drops its per-job scratch dir as soon
    as the render is done, so a test cannot look at the file afterwards.
    """
    calls = []

    def convert(docx_path, pdf_path, profile_dir=None, timeout=None):
        with open(docx_path, "rb") as handle:
            calls.append(handle.read())
        if failure is not None:
            raise failure
        with open(pdf_path, "wb") as handle:
            handle.write(b"%PDF-1.4 stub")
        return pdf_path

    monkeypatch.setattr(rerender_worker.renderer_module, "convert_docx_to_pdf", convert)
    return calls


def delivery(job_id="rerender-1"):
    return Delivery(payload=RerenderMessage(job_id=job_id).model_dump())


def store_upload(job_id="rerender-1", content=UPLOAD, filename="tailored.docx"):
    """What the board does on upload: keep the bytes, mark the request `queued`."""
    return db_module.get_db().upsert_docx_update(
        job_id, rerender_worker.RERENDER_QUEUED, filename=filename, content=content
    )


def test_an_uploaded_docx_becomes_the_deliverable_and_the_pdf_follows(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            store = db_module.get_db()
            store.upsert_job(job_row())
            store_upload()
            calls = fake_render(monkeypatch)

            result = rerender_worker.handle_delivery(delivery())

            assert result.outcome == Outcome.ACK
            assert calls == [UPLOAD], "the converter saw exactly the uploaded bytes"
            row = store.get_job("rerender-1")
            assert row["docx_path"].endswith("900123.docx")
            assert row["pdf_url"].endswith("900123.pdf")
            with open(row["docx_path"], "rb") as handle:
                assert handle.read() == UPLOAD, "the artifact is the upload, in place"
            assert os.path.exists(row["pdf_url"]), "and the PDF was rewritten next to it"
            assert (
                store.get_docx_update("rerender-1")["status"]
                == rerender_worker.RERENDER_COMPLETED
            )


def test_a_rerender_keeps_the_candidate_name_on_the_deliverable(monkeypatch):
    """The second call site of the same name: a re-render must not rename the file back.

    The uploaded DOCX replaces the artifact *in place*, so it is written under the same key the
    tailoring pipeline used - which now means the same `<candidate>-<vacancy>` stem.
    """
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            store = db_module.get_db()
            store.upsert_job(job_row())
            seed_candidate("u-1", {**SAMPLE_CANDIDATE, "full_name": "Artem Muntianu"})
            store_upload()
            fake_render(monkeypatch)

            assert rerender_worker.handle_delivery(delivery()).outcome == Outcome.ACK

            row = store.get_job("rerender-1")
            assert row["docx_path"].endswith("artemmuntianu-900123.docx")
            assert row["pdf_url"].endswith("artemmuntianu-900123.pdf")
            assert os.path.exists(row["pdf_url"])


def test_a_redelivery_of_an_already_rendered_upload_costs_nothing(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            store = db_module.get_db()
            store.upsert_job(job_row())
            store_upload()
            fake_render(monkeypatch)
            assert rerender_worker.handle_delivery(delivery()).outcome == Outcome.ACK

            calls = fake_render(monkeypatch)
            again = rerender_worker.handle_delivery(delivery())

            assert again.outcome == Outcome.ACK
            assert again.reason == "duplicate"
            assert calls == [], "an already-rendered upload must not convert twice"


def test_a_second_upload_is_a_genuine_request(monkeypatch):
    """The board resets the row to `queued`, so `completed` is what marks a duplicate."""
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            store = db_module.get_db()
            store.upsert_job(job_row())
            store_upload()
            fake_render(monkeypatch)
            rerender_worker.handle_delivery(delivery())

            second = b"PK\x03\x04 second edit"
            store_upload(content=second)
            calls = fake_render(monkeypatch)
            result = rerender_worker.handle_delivery(delivery())

            assert result.outcome == Outcome.ACK
            assert calls == [second], "a new upload must render again, with the new bytes"


def test_a_removed_vacancy_is_acked_without_rendering(monkeypatch):
    """The row cascades with the card, so a late request has nothing to render - and no retry."""
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            calls = fake_render(monkeypatch)
            result = rerender_worker.handle_delivery(delivery())

            assert result.outcome == Outcome.ACK
            assert result.reason == "vacancy gone"
            assert calls == []


def test_a_request_without_an_upload_is_dead_lettered(monkeypatch):
    """A broken row, not a transient failure: retrying it would never produce a file."""
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            store = db_module.get_db()
            store.upsert_job(job_row())
            calls = fake_render(monkeypatch)

            result = rerender_worker.handle_delivery(delivery())

            assert result.outcome == Outcome.DEAD_LETTER
            assert calls == []
            assert (
                store.get_docx_update("rerender-1")["status"] == rerender_worker.RERENDER_FAILED
            )


def test_a_card_without_a_tailored_deliverable_is_refused(monkeypatch):
    """The button is only offered for a tailored card; the worker refuses to invent one."""
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            store = db_module.get_db()
            store.upsert_job(job_row(docx_path=None, pdf_url=None))
            store_upload()
            calls = fake_render(monkeypatch)

            result = rerender_worker.handle_delivery(delivery())

            assert result.outcome == Outcome.DEAD_LETTER
            assert calls == []
            assert (
                store.get_docx_update("rerender-1")["status"] == rerender_worker.RERENDER_FAILED
            )


def test_an_upload_over_the_cap_is_dead_lettered(monkeypatch):
    """The cap is mirrored by the board, and the worker does not trust the board's copy."""
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            store = db_module.get_db()
            store.upsert_job(job_row())
            store_upload(content=b"PK\x03\x04" + b"x" * 64)
            monkeypatch.setattr(rerender_worker.config, "MAX_DOCX_UPLOAD_BYTES", 16)
            calls = fake_render(monkeypatch)

            result = rerender_worker.handle_delivery(delivery())

            assert result.outcome == Outcome.DEAD_LETTER
            assert calls == []


def test_a_failing_render_stays_queued_and_then_dead_letters(monkeypatch):
    """A wedged soffice is worth retrying; the row says `queued` until the attempts run out."""
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            store = db_module.get_db()
            store.upsert_job(job_row())
            store_upload()
            monkeypatch.setattr(rerender_worker.config, "MAX_ATTEMPTS", 2)
            fake_render(monkeypatch, failure=RuntimeError("soffice exploded"))

            first = rerender_worker.handle_delivery(delivery())
            assert first.outcome == Outcome.RETRY
            assert (
                store.get_docx_update("rerender-1")["status"] == rerender_worker.RERENDER_QUEUED
            )
            assert store.get_job("rerender-1")["docx_path"] == "/data/output/900123.docx", (
                "a failed render must leave the previous deliverable alone"
            )

            second = rerender_worker.handle_delivery(delivery())
            assert second.outcome == Outcome.DEAD_LETTER
            assert (
                store.get_docx_update("rerender-1")["status"] == rerender_worker.RERENDER_FAILED
            )


def test_the_uploaded_bytes_survive_the_store_round_trip():
    """The payload is the point of the row: it has to come back byte for byte, and not in every
    row a caller reads (a megabyte does not belong in a status object)."""
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            store = db_module.get_db()
            store.upsert_job(job_row())
            store_upload(content=b"\x00\x01PK\x03\x04")

            assert store.load_docx_update("rerender-1") == b"\x00\x01PK\x03\x04"
            row = store.get_docx_update("rerender-1")
            assert row["size_bytes"] == 6 and row["filename"] == "tailored.docx"
            assert not any("content" in key for key in row), "the payload stays out of the row"
            assert store.load_docx_update("no-such-card") is None


def test_the_rerender_queue_is_its_own_storage():
    """A render consumer must not eat tailoring messages (or the other way round)."""
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            task_queue = get_queue()
            rerender_queue = get_queue(spec=rerender_queue_spec())

            assert rerender_queue is not task_queue
            assert rerender_queue.base_dir != task_queue.base_dir

            rerender_queue.publish({"job_id": "rerender-1"})
            assert rerender_queue.depth() == 1
            assert task_queue.depth() == 0
