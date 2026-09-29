"""Cover-letter worker: consumes `resumes.cover`, one card per message.

Same shape as `worker.py` - one process per pod, `prefetch_count = 1`, ack only after the row
is written, SIGTERM finishes the in-flight letter - but one Gemini call instead of the
LangGraph run, and its own queue with its own KEDA `ScaledObject`, so a batch of letters never
wakes the tailoring workers (and vice versa).

    python cover.py                 # consume forever
    python cover.py --once          # drain what is requested, then exit
    python cover.py --max-messages 5

What it writes
--------------
`resume_cover_letter`, one row per vacancy: `queued` (the board asked for it) -> `running` ->
`completed` (with the text and the model that wrote it) or `failed` (with the reason). The
board reads that row through the card payload, so the modal shows the letter as soon as it
lands - no push channel involved.

Idempotency: a redelivery whose letter is already `completed` is acked without calling Gemini.
A *regeneration* works because the board resets the row to `queued` before publishing, so a
`queued` row is always a genuine request, never a stale one.
"""

import argparse
import signal
import sys
import threading
import time

from pydantic import ValidationError

import config
from agent.contracts import CoverLetterMessage
from agent.cover import run_cover_letter
from utils import candidate as candidate_module
from utils import db as db_module
from utils.cv_text import load_cv_data
from utils.logging_setup import (
    get_logger,
    setup_logging,
    start_heartbeat_thread,
    write_heartbeat,
)
from utils.messaging import HandlerResult, cover_queue_spec, get_queue
from utils.retry import RetryLater
from worker import verify_model_availability

log = get_logger(__name__)
STOP_EVENT = threading.Event()

# Statuses of `resume_cover_letter.status`. The board writes `queued` when it publishes; this
# worker owns the rest.
COVER_QUEUED = "queued"
COVER_RUNNING = "running"
COVER_COMPLETED = "completed"
COVER_FAILED = "failed"


def _install_signal_handlers(queue) -> None:
    def _handler(signum, _frame):
        log.warning("shutdown signal received - finishing the in-flight letter", signal=signum)
        STOP_EVENT.set()
        queue.stop()

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _handler)
        except (ValueError, OSError):  # not on the main thread
            pass


def preflight() -> dict:
    """Fail fast on misconfiguration, without the render tools this service never uses.

    `verify_model_availability` is shared with `worker.py` on purpose: a placeholder
    `MODEL_NAME` is a non-retryable 400, and there must be exactly one implementation of that
    guard. (The `agent/` layer may not import an entry point; entry points may agree with each
    other.)
    """
    status = {}
    db = db_module.get_db()
    db.ping()
    status["db"] = db.backend

    if not config.GEMINI_API_KEY:
        log.warning("GEMINI_API_KEY is not set - relying on ADC credentials")
    status["models"] = verify_model_availability()
    return status


def _ms(started) -> int:
    return int((time.time() - started) * 1000)


def handle_delivery(delivery) -> HandlerResult:
    """Write one cover letter and report what the broker should do with the message."""
    try:
        request = CoverLetterMessage.model_validate(delivery.payload)
    except ValidationError as exc:
        log.error("invalid cover-letter payload - dead-lettering", error=str(exc)[:400])
        return HandlerResult.dead_letter(reason="invalid payload")

    job_log = log.bind(job_id=request.job_id, attempt=request.attempt)
    store = db_module.get_db()

    # 1. The vacancy may be gone (removed while the request sat in the queue): its letter row
    #    cascades with it, and there is nothing to write - ack rather than retry forever.
    try:
        row = store.get_job(request.job_id)
        previous = store.get_cover_letter(request.job_id)
    except Exception as exc:  # noqa: BLE001
        return HandlerResult.retry_later(
            delay_seconds=60, reason=f"job store unavailable: {exc}"
        )
    if row is None:
        job_log.info("vacancy is gone - nothing to write")
        return HandlerResult.ack(reason="vacancy gone")
    if previous and previous.get("status") == COVER_COMPLETED and previous.get("text"):
        job_log.info("cover letter already written - acking duplicate")
        return HandlerResult.ack(reason="duplicate")

    attempts = int((previous or {}).get("attempts") or 0) + 1
    job_log = job_log.bind(attempts=attempts)
    started = time.time()

    def write(status, **fields):
        try:
            store.upsert_cover_letter(request.job_id, status, attempts=attempts, **fields)
        except Exception as exc:  # noqa: BLE001 - a status write must not kill the letter
            job_log.warning(
                "could not persist cover-letter status", status=status, error=str(exc)
            )

    # 2. The three inputs: the vacancy's own description (stored by the intake), the master CV
    #    model the tailoring prompt is built from, and the candidate facts - the same
    #    `application_profile` row `apply.py` reads, used as the ground-truth block.
    try:
        cv_data = load_cv_data()
    except Exception as exc:  # noqa: BLE001
        job_log.error("could not read cv_data.json", error=str(exc))
        write(COVER_FAILED, error=str(exc)[:500])
        return HandlerResult.dead_letter(reason=f"cv_data unavailable: {exc}")

    candidate = candidate_module.load(store, row.get("user_id"))

    write(COVER_RUNNING)

    # 3. One Gemini call.
    try:
        letter = run_cover_letter(
            request.job_id,
            row.get("description_raw"),
            cv_data,
            title=row.get("title") or "",
            company=row.get("company") or "",
            candidate=candidate,
        )
    except RetryLater as exc:
        job_log.warning("cover letter deferred", reason=exc.reason, delay=exc.delay_seconds)
        write(COVER_QUEUED, error=exc.reason)
        return HandlerResult.retry_later(delay_seconds=exc.delay_seconds, reason=exc.reason)
    except ValueError as exc:
        # Nothing to write from, or an empty answer: retrying cannot help.
        job_log.error("cover letter cannot be written", error=str(exc))
        write(COVER_FAILED, error=str(exc)[:500])
        return HandlerResult.dead_letter(reason=str(exc))
    except Exception as exc:  # noqa: BLE001
        job_log.exception("cover letter failed", error=str(exc))
        write(COVER_FAILED, error=str(exc)[:500])
        if attempts >= config.MAX_ATTEMPTS:
            job_log.error("attempt limit reached - parking in the dead-letter queue")
            return HandlerResult.dead_letter(reason=str(exc))
        return HandlerResult.retry(reason=str(exc))

    write(COVER_COMPLETED, text=letter, model=config.MODEL_NAME, error=None)
    job_log.info("cover letter written", ms=_ms(started), chars=len(letter))
    write_heartbeat()
    return HandlerResult.ack(reason="completed")


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Cover-letter queue worker")
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
        "cover-letter worker starting",
        queue=config.COVER_QUEUE_NAME,
        queue_backend=config.QUEUE_BACKEND,
        db_backend=config.DB_BACKEND,
        model_state_backend=config.MODEL_STATE_BACKEND,
    )

    if not args.skip_preflight:
        try:
            log.info("preflight ok", **preflight())
        except Exception as exc:  # noqa: BLE001
            log.error("preflight failed - refusing to start", error=str(exc))
            return 2

    queue = get_queue(spec=cover_queue_spec())
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

    log.info("cover-letter worker stopped", processed=processed)
    return 0


if __name__ == "__main__":
    sys.exit(main())
