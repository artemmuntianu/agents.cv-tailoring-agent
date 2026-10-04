"""Application-form worker: consumes `applications.draft`, one rendered form per message.

Same shape as `cover.py` - one process per pod, `prefetch_count = 1`, ack only after the row is
written, SIGTERM finishes the in-flight draft, its own queue with its own KEDA `ScaledObject` - but
the job is a *mapping* one: the extension sends the application form it annotated
(`data-cvt-id` on every control), and the worker answers with a plan the extension applies to that
DOM. The generated cover letter and the tailored PDF are never part of this: the extension inserts
those itself, from the board.

    python apply.py                 # consume forever
    python apply.py --once          # drain what is requested, then exit
    python apply.py --max-messages 5

What it writes
--------------
`resume_application`, one row per vacancy: `queued` (the extension asked) -> `running` ->
`completed` (with the plan and the model that produced it) or `failed` (with the reason). The
extension reads that row through `GET /api/apply/<job_id>` while it polls.

Idempotency: the row also records the `schema_hash` of the snapshot the plan was produced for, so a
redelivery whose plan is already `completed` **for the same form** is acked without calling Gemini
- while a changed form (or a changed candidate file) is a genuine re-draft, because the extension
asks with a new hash.
"""

import argparse
import signal
import sys
import threading
import time

from pydantic import ValidationError

import config
from agent.application import run_application_draft
from agent.contracts import ApplicationDraftMessage
from utils import candidate as candidate_module
from utils import db as db_module
from utils.cv_text import load_cv_data
from utils.logging_setup import (
    get_logger,
    setup_logging,
    start_heartbeat_thread,
    write_heartbeat,
)
from utils.messaging import HandlerResult, application_queue_spec, get_queue
from utils.retry import RetryLater
from worker import verify_model_availability

log = get_logger(__name__)
STOP_EVENT = threading.Event()

# Statuses of `resume_application.status`. The board writes `queued` when the extension asks; this
# worker owns the rest.
APPLICATION_QUEUED = "queued"
APPLICATION_RUNNING = "running"
APPLICATION_COMPLETED = "completed"
APPLICATION_FAILED = "failed"


def _install_signal_handlers(queue) -> None:
    def _handler(signum, _frame):
        log.warning("shutdown signal received - finishing the in-flight draft", signal=signum)
        STOP_EVENT.set()
        queue.stop()

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _handler)
        except (ValueError, OSError):  # not on the main thread
            pass


def preflight() -> dict:
    """Fail fast on misconfiguration, without the render tools this service never uses."""
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
    """Draft one application form and report what the broker should do with the message."""
    try:
        request = ApplicationDraftMessage.model_validate(delivery.payload)
    except ValidationError as exc:
        log.error("invalid application-draft payload - dead-lettering", error=str(exc)[:400])
        return HandlerResult.dead_letter(reason="invalid payload")

    job_log = log.bind(job_id=request.job_id, attempt=request.attempt, host=request.host)
    store = db_module.get_db()

    # 1. The vacancy may be gone (removed while the request sat in the queue): its draft row
    #    cascades with it, and there is nothing to answer - ack rather than retry forever.
    try:
        row = store.get_job(request.job_id)
        previous = store.get_application(request.job_id)
    except Exception as exc:  # noqa: BLE001
        return HandlerResult.retry_later(delay_seconds=60, reason=f"job store unavailable: {exc}")
    if row is None:
        job_log.info("vacancy is gone - nothing to draft")
        return HandlerResult.ack(reason="vacancy gone")

    # A redelivery of the *same* form: the plan is already there and a second Gemini call would
    # only cost quota. A different hash is a genuine re-draft, so it falls through.
    if (
        previous
        and previous.get("status") == APPLICATION_COMPLETED
        and previous.get("plan")
        and request.schema_hash
        and previous.get("schema_hash") == request.schema_hash
    ):
        job_log.info("form already drafted for this snapshot - acking duplicate")
        return HandlerResult.ack(reason="duplicate")

    attempts = int((previous or {}).get("attempts") or 0) + 1
    job_log = job_log.bind(attempts=attempts, fields=len(request.form.fields))
    started = time.time()

    def write(status, **fields):
        try:
            store.upsert_application(
                request.job_id,
                status,
                attempts=attempts,
                schema_hash=request.schema_hash or None,
                **fields,
            )
        except Exception as exc:  # noqa: BLE001 - a status write must not kill the draft
            job_log.warning("could not persist application status", status=status, error=str(exc))

    # 2. The inputs: the vacancy's own description (stored by the intake), the master CV model and
    #    the candidate facts the prompt is not allowed to invent.
    try:
        cv_data = load_cv_data()
    except Exception as exc:  # noqa: BLE001
        job_log.error("could not read cv_data.json", error=str(exc))
        write(APPLICATION_FAILED, error=str(exc)[:500])
        return HandlerResult.dead_letter(reason=f"cv_data unavailable: {exc}")

    candidate = candidate_module.load(store, row.get("user_id"))
    write(APPLICATION_RUNNING)

    # 3. One Gemini call.
    try:
        plan = run_application_draft(
            request.job_id,
            row.get("description_raw"),
            candidate,
            request.form,
            cv_data=cv_data,
            title=row.get("title") or "",
            company=row.get("company") or "",
        )
    except RetryLater as exc:
        job_log.warning("application draft deferred", reason=exc.reason, delay=exc.delay_seconds)
        write(APPLICATION_QUEUED, error=exc.reason)
        return HandlerResult.retry_later(delay_seconds=exc.delay_seconds, reason=exc.reason)
    except ValueError as exc:
        # Nothing to work from, or the model broke the contract: retrying cannot help.
        job_log.error("application draft cannot be produced", error=str(exc))
        write(APPLICATION_FAILED, error=str(exc)[:500])
        return HandlerResult.dead_letter(reason=str(exc))
    except Exception as exc:  # noqa: BLE001
        job_log.exception("application draft failed", error=str(exc))
        write(APPLICATION_FAILED, error=str(exc)[:500])
        if attempts >= config.MAX_ATTEMPTS:
            job_log.error("attempt limit reached - parking in the dead-letter queue")
            return HandlerResult.dead_letter(reason=str(exc))
        return HandlerResult.retry(reason=str(exc))

    write(APPLICATION_COMPLETED, plan=plan, model=config.MODEL_NAME, error=None)
    job_log.info(
        "application drafted",
        ms=_ms(started),
        decided=len(plan.get("fields") or []),
        undecided=len(plan.get("undecided") or []),
    )
    write_heartbeat()
    return HandlerResult.ack(reason="completed")


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Application-form queue worker")
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
        "application worker starting",
        queue=config.APPLICATION_QUEUE_NAME,
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

    queue = get_queue(spec=application_queue_spec())
    _install_signal_handlers(queue)

    max_messages = args.max_messages
    if args.once and max_messages is None:
        pending = getattr(queue, "pending_count", None)
        available = pending() if callable(pending) else (queue.depth() or 0)
        max_messages = max(0, int(available))

    write_heartbeat()
    start_heartbeat_thread(STOP_EVENT)
    try:
        processed = queue.consume(handle_delivery, max_messages=max_messages, stop_event=STOP_EVENT)
    finally:
        queue.close()

    log.info("application worker stopped", processed=processed)
    return 0


if __name__ == "__main__":
    sys.exit(main())
