"""Hand-edited deliverable worker: consumes `resumes.rerender`, one card per message.

The board's *Update docx* button, in workflow terms: the operator downloads the tailored DOCX,
verifies it, fixes what the model could not, and uploads the result back. The bytes are stored in
`resume_docx_update` (the board runs outside the cluster and cannot write the artifact volume),
and this worker turns them into the card's deliverable again - the uploaded DOCX is written to the
artifact key the tailoring pipeline uses, LibreOffice converts it to a PDF, and both paths are
repointed on `resumes`. Every existing link, mirror and download keeps working, because as far as
the board is concerned the deliverable simply changed.

Same shape as `worker.py`/`cover.py` - one process per pod, `prefetch_count = 1`, ack only after
the row and the files are written, SIGTERM finishes the in-flight conversion - but the tool it
cannot work without is the image's LibreOffice rather than Gemini, which is why `preflight`
asserts the render tools instead of the model ladder.

    python rerender.py                # consume forever
    python rerender.py --once         # drain what is requested, then exit
    python rerender.py --max-messages 5

What it writes
--------------
`resume_docx_update`, one row per vacancy: `queued` (the board stored an upload and asked for a
render) -> `running` -> `completed` (the new pair is on the volume) or `failed` (with the reason).
The board reads that row through the card payload, so the modal shows the outcome with no push
channel involved.

Idempotency: a redelivery whose row is already `completed` is acked without rendering again. A
*second* edit works because uploading resets the row to `queued`, so a `queued` row is always a
genuine request and never a stale one.
"""

import argparse
import os
import shutil
import signal
import sys
import threading
import time
from types import SimpleNamespace

from pydantic import ValidationError

import config
from agent.contracts import RerenderMessage
from utils import db as db_module
from utils import renderer as renderer_module
from utils import storage as storage_module
from utils.logging_setup import (
    get_logger,
    setup_logging,
    start_heartbeat_thread,
    write_heartbeat,
)
from utils.messaging import HandlerResult, get_queue, rerender_queue_spec

log = get_logger(__name__)
STOP_EVENT = threading.Event()

# Statuses of `resume_docx_update.status`. The board writes `queued` when it stores an upload;
# this worker owns the rest.
RERENDER_QUEUED = "queued"
RERENDER_RUNNING = "running"
RERENDER_COMPLETED = "completed"
RERENDER_FAILED = "failed"


def _install_signal_handlers(queue) -> None:
    def _handler(signum, _frame):
        log.warning("shutdown signal received - finishing the in-flight render", signal=signum)
        STOP_EVENT.set()
        queue.stop()

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _handler)
        except (ValueError, OSError):  # not on the main thread
            pass


def preflight() -> dict:
    """Fail fast on misconfiguration, and on a pod that cannot convert anything.

    `assert_render_tools_available` is the guard that matters here: every message this worker
    receives needs LibreOffice, so a pod without it would dead-letter uploads one by one instead of
    failing its own startup. The model ladder is checked by `worker.py` and `cover.py` - this
    service never calls a model.
    """
    status = {}
    db = db_module.get_db()
    db.ping()
    status["db"] = db.backend
    renderer_module.assert_render_tools_available()
    status["render_tools"] = "ok"
    return status


def _ms(started) -> int:
    return int((time.time() - started) * 1000)


def _cleanup(workdir: str) -> None:
    """Drop the per-job scratch dir (`KEEP_TEMP_DIRS` keeps it for debugging, like the worker)."""
    if config.KEEP_TEMP_DIRS:
        return
    shutil.rmtree(workdir, ignore_errors=True)


def handle_delivery(delivery) -> HandlerResult:
    """Replace one card's deliverable and report what the broker should do with the message."""
    try:
        request = RerenderMessage.model_validate(delivery.payload)
    except ValidationError as exc:
        log.error("invalid rerender payload - dead-lettering", error=str(exc)[:400])
        return HandlerResult.dead_letter(reason="invalid payload")

    job_log = log.bind(job_id=request.job_id, attempt=request.attempt)
    store = db_module.get_db()

    # 1. The vacancy may be gone (removed while the request sat in the queue): its row cascades
    #    with it, and there is nothing to render - ack rather than retry forever.
    try:
        row = store.get_job(request.job_id)
        previous = store.get_docx_update(request.job_id)
    except Exception as exc:  # noqa: BLE001
        return HandlerResult.retry_later(
            delay_seconds=60, reason=f"job store unavailable: {exc}"
        )
    if row is None:
        job_log.info("vacancy is gone - nothing to render")
        return HandlerResult.ack(reason="vacancy gone")
    if previous and previous.get("status") == RERENDER_COMPLETED:
        job_log.info("this upload is already rendered - acking duplicate")
        return HandlerResult.ack(reason="duplicate")

    attempts = int((previous or {}).get("attempts") or 0) + 1
    job_log = job_log.bind(attempts=attempts)
    started = time.time()

    def write(status, **fields):
        try:
            store.upsert_docx_update(request.job_id, status, attempts=attempts, **fields)
        except Exception as exc:  # noqa: BLE001 - a status write must not kill the render
            job_log.warning(
                "could not persist upload status", status=status, error=str(exc)
            )

    # 2. The upload itself. Nothing here can be retried into existence: a request with no bytes, or
    #    a card that never went through tailoring, is a broken row - the button is only offered for
    #    a card that has a `docx_path`.
    try:
        content = store.load_docx_update(request.job_id)
    except Exception as exc:  # noqa: BLE001
        job_log.warning("could not read the uploaded docx", error=str(exc))
        return HandlerResult.retry_later(delay_seconds=60, reason="job store unavailable")
    if not content:
        job_log.error("no uploaded docx for this card - nothing to render")
        write(RERENDER_FAILED, error="no uploaded docx")
        return HandlerResult.dead_letter(reason="no uploaded docx")
    if len(content) > config.MAX_DOCX_UPLOAD_BYTES:
        job_log.error("the uploaded docx is too large", size_bytes=len(content))
        write(RERENDER_FAILED, error="upload exceeds MAX_DOCX_UPLOAD_BYTES")
        return HandlerResult.dead_letter(reason="upload too large")
    if not row.get("docx_path"):
        job_log.error("this card has no tailored deliverable to replace")
        write(RERENDER_FAILED, error="this card has no tailored deliverable")
        return HandlerResult.dead_letter(reason="no tailored deliverable")

    write(RERENDER_RUNNING)

    # 3. Render. The uploaded DOCX becomes the deliverable *in place* - the same artifact key the
    #    tailoring pipeline uses - so the board's PDF/DOCX links, the artifact mirror and the
    #    operator's own download path stay exactly as they were. A per-job LibreOffice profile and
    #    scratch dir keep two conversions on one node from fighting over the default profile lock.
    external_id = row.get("external_id") or "cv"
    workdir = os.path.join(
        config.TEMP_ROOT,
        f"rerender-{storage_module._safe_component(request.job_id, 'job')}",
    )
    local_docx = os.path.join(
        workdir, f"cv_{storage_module._safe_component(external_id, 'cv')}.docx"
    )
    task = SimpleNamespace(
        job_id=request.job_id, user_id=row.get("user_id"), external_id=external_id
    )
    try:
        os.makedirs(workdir, exist_ok=True)
        with open(local_docx, "wb") as handle:
            handle.write(content)
        docx_path = storage_module.get_storage().upload(
            local_docx, storage_module.output_key_for(task, ".docx")
        )
        pdf_path = renderer_module.convert_docx_to_pdf(
            local_docx,
            os.path.join(workdir, "rendered.pdf"),
            profile_dir=os.path.join(workdir, "lo-profile"),
        )
        pdf_url = storage_module.get_storage().upload(
            pdf_path, storage_module.output_key_for(task, ".pdf")
        )
    except Exception as exc:  # noqa: BLE001
        _cleanup(workdir)
        job_log.exception("rendering the uploaded docx failed", error=str(exc))
        if attempts >= config.MAX_ATTEMPTS:
            write(RERENDER_FAILED, error=str(exc)[:500])
            job_log.error("attempt limit reached - parking in the dead-letter queue")
            return HandlerResult.dead_letter(reason=str(exc))
        # Still a live request: the row says so, and the broker will bring it back.
        write(RERENDER_QUEUED, error=str(exc)[:500])
        return HandlerResult.retry(reason=str(exc))

    # 4. Point the card at the new pair, then say so. This write comes last on purpose: a crash
    #    before it leaves the request `running`, the broker redelivers, and the render runs again -
    #    the artifact write is idempotent, so the worst case is one wasted conversion.
    try:
        store.update_job(request.job_id, docx_path=docx_path, pdf_url=pdf_url)
    except Exception as exc:  # noqa: BLE001
        _cleanup(workdir)
        job_log.warning("could not repoint the card's artifacts", error=str(exc))
        write(RERENDER_QUEUED, error=str(exc)[:500])
        return HandlerResult.retry(reason="job store unavailable")
    _cleanup(workdir)

    write(RERENDER_COMPLETED, error=None)
    job_log.info(
        "deliverable replaced",
        ms=_ms(started),
        docx=docx_path,
        pdf=pdf_url,
        size_bytes=len(content),
    )
    write_heartbeat()
    return HandlerResult.ack(reason="completed")


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Hand-edited-deliverable queue worker")
    parser.add_argument(
        "--once", action="store_true", help="process what is currently queued, then exit"
    )
    parser.add_argument("--max-messages", type=int, default=None)
    parser.add_argument(
        "--queue-backend",
        choices=["directory", "amqp"],
        default=None,
        help="override QUEUE_BACKEND",
    )
    parser.add_argument("--skip-preflight", action="store_true")
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    if args.queue_backend:
        config.QUEUE_BACKEND = args.queue_backend

    setup_logging()
    log.info(
        "rerender worker starting",
        queue=config.RERENDER_QUEUE_NAME,
        queue_backend=config.QUEUE_BACKEND,
        db_backend=config.DB_BACKEND,
    )

    if not args.skip_preflight:
        try:
            log.info("preflight ok", **preflight())
        except Exception as exc:  # noqa: BLE001
            log.error("preflight failed - refusing to start", error=str(exc))
            return 2

    queue = get_queue(spec=rerender_queue_spec())
    _install_signal_handlers(queue)

    max_messages = args.max_messages
    if args.once and max_messages is None:
        pending = getattr(queue, "pending_count", None)
        available = pending() if callable(pending) else (queue.depth() or 0)
        max_messages = max(0, int(available))

    write_heartbeat()
    start_heartbeat_thread(STOP_EVENT)
    try:
        processed = queue.consume(
            handle_delivery, max_messages=max_messages, stop_event=STOP_EVENT
        )
    finally:
        queue.close()

    log.info("rerender worker stopped", processed=processed)
    return 0


if __name__ == "__main__":
    sys.exit(main())
