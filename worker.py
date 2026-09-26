"""Queue consumer entry point (the "AI worker pod").

One process == one pod replica. It consumes a single message at a time
(`prefetch_count = 1`), adapts the master CV with LangGraph, uploads the result
and only then acks. KEDA scales the replicas 0 -> N from the `resumes.generate`
queue depth and back to 0 once the queue drains.

    python worker.py                 # consume forever
    python worker.py --once          # drain what is queued, then exit
    python worker.py --max-messages 5

Graceful shutdown: SIGTERM stops the consumer and lets the in-flight task finish
(and be acked) before the process exits.
"""

import argparse
import shutil
import signal
import sys
import threading
import time

from pydantic import ValidationError

import config
from agent.contracts import JobStatus, ResumeTaskMessage
from agent.pipeline import run_task
from utils import db as db_module
from utils import storage as storage_module
from utils.logging_setup import get_logger, setup_logging, write_heartbeat
from utils.messaging import HandlerResult, get_queue
from utils.retry import RetryLater

log = get_logger(__name__)
STOP_EVENT = threading.Event()


def _install_signal_handlers(queue) -> None:
    def _handler(signum, _frame):
        log.warning("shutdown signal received - finishing the in-flight task", signal=signum)
        STOP_EVENT.set()
        queue.stop()

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _handler)
        except (ValueError, OSError):  # not on the main thread
            pass


def preflight(skip_render_check: bool = False) -> dict:
    """Fail fast on misconfiguration instead of mid-task."""
    status = {}
    storage = storage_module.get_storage()
    status["storage"] = storage.backend

    db = db_module.get_db()
    db.ping()
    status["db"] = db.backend

    if not skip_render_check:
        from utils.renderer import assert_render_tools_available

        tools = assert_render_tools_available()
        status["libreoffice"] = tools["libreoffice"]
        status["poppler"] = tools["pdftoppm"]

    if not config.GEMINI_API_KEY:
        log.warning("GEMINI_API_KEY is not set - relying on ADC credentials")

    status["models"] = verify_model_availability()
    return status


def verify_model_availability() -> str:
    """Refuse to start when MODEL_NAME does not exist for this API key.

    A wrong model id returns a *non-retryable* 400, so without this check every
    task would burn its attempts and end up in the DLQ. Authentication and
    transport problems are only warned about (local/dev runs stay usable).
    """
    from agent.nodes import get_genai_client

    try:
        client = get_genai_client()
        available = {model.name.split("/")[-1] for model in client.models.list()}
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "could not list Gemini models - skipping model validation", error=str(exc)
        )
        return "unverified"

    if not available:
        log.warning("models.list() returned nothing - skipping model validation")
        return "unverified"

    if config.MODEL_NAME not in available:
        raise RuntimeError(
            f"MODEL_NAME={config.MODEL_NAME!r} is not available for this API key. "
            f"Available models: {', '.join(sorted(available))}"
        )

    usable = [model for model in config.PREFERRED_MODELS if model in available]
    missing = [model for model in config.PREFERRED_MODELS if model not in available]
    if usable:
        config.PREFERRED_MODELS = usable
    if missing:
        log.warning("dropping unavailable fallback models", dropped=",".join(missing))
    return f"{config.MODEL_NAME} (fallbacks: {','.join(usable[1:]) or 'none'})"


def mark_status(job_id: str, status: str, **extra) -> None:
    """Persist a status transition for the claimed row id."""
    try:
        db_module.get_db().update_job(job_id, status=status, **extra)
    except Exception as exc:  # noqa: BLE001 - status writes must never break a task
        log.warning("could not persist status", status=status, error=str(exc))


def _ms(started):
    return int((time.time() - started) * 1000)


def _cleanup(path):
    try:
        shutil.rmtree(path, ignore_errors=True)
    except Exception:  # noqa: BLE001
        pass


def handle_delivery(delivery) -> HandlerResult:
    """Process one message and report what the broker should do with it."""
    try:
        task = ResumeTaskMessage.model_validate(delivery.payload)
    except ValidationError as exc:
        log.error("invalid task payload - dead-lettering", error=str(exc)[:400])
        return HandlerResult.dead_letter(reason="invalid payload")

    job_log = log.bind(
        job_id=task.job_id, external_id=task.external_id, attempt=task.attempt
    )

    # 1. Idempotency: a redelivered or duplicated message must not pay for Gemini
    #    twice. Successor of the CLI's "already tailored" pre-filter.
    try:
        completed = db_module.get_db().find_completed(task.key())
    except Exception as exc:  # noqa: BLE001
        return HandlerResult.retry_later(
            delay_seconds=60, reason=f"job store unavailable: {exc}"
        )
    if completed:
        job_log.info("already completed - acking duplicate", pdf_url=completed.get("pdf_url"))
        return HandlerResult.ack(reason="duplicate")

    # 2. Claim the row. upsert_job reports whether this task owns the work,
    #    whether the vacancy is already handled (duplicate delivery), or whether
    #    the supplied job_id belongs to a foreign row.
    try:
        claim = db_module.get_db().upsert_job(task.to_job_row(JobStatus.PROCESSING))
        outcome = claim.get("outcome", "claimed")
        if outcome != "claimed":
            job_log.info(
                "not claiming this task", outcome=outcome, row_job_id=claim.get("job_id")
            )
            return HandlerResult.ack(reason=outcome)
        row_job_id = claim.get("job_id") or task.job_id
        attempts = db_module.get_db().increment_attempts(row_job_id)
    except Exception as exc:  # noqa: BLE001
        job_log.warning("could not persist job claim", error=str(exc))
        row_job_id = task.job_id
        attempts = int(task.attempt or 0) + 1

    job_log = job_log.bind(job_id=row_job_id, attempts=attempts)
    started = time.time()

    # 3. Materialise inputs (master cv.docx + cv_data.json).
    storage = storage_module.get_storage()
    try:
        context = storage.prepare_task(task)
    except Exception as exc:  # noqa: BLE001
        job_log.error("could not prepare task inputs", error=str(exc))
        mark_status(row_job_id, JobStatus.FAILED, error=str(exc)[:500])
        return HandlerResult.retry_later(
            delay_seconds=300, reason=f"input preparation failed: {exc}"
        )

    # 4. Run the graph (adapt -> render -> vision -> persist).
    try:
        final_state = run_task(
            task,
            job_id=row_job_id,
            cv_path=context.cv_path,
            cv_data=context.cv_data,
            output_path=context.output_path,
            temp_dir=context.temp_dir,
        )
    except RetryLater as exc:
        job_log.warning("task deferred", reason=exc.reason, delay_seconds=exc.delay_seconds)
        mark_status(row_job_id, JobStatus.RATE_LIMITED, error=exc.reason)
        return HandlerResult.retry_later(delay_seconds=exc.delay_seconds, reason=exc.reason)
    except Exception as exc:  # noqa: BLE001
        job_log.exception("task failed", error=str(exc))
        mark_status(row_job_id, JobStatus.FAILED, error=str(exc)[:500], duration_ms=_ms(started))
        if attempts >= config.MAX_ATTEMPTS:
            job_log.error("attempt limit reached - parking in the dead-letter queue")
            mark_status(row_job_id, JobStatus.DEAD_LETTERED, error=str(exc)[:500])
            return HandlerResult.dead_letter(reason=str(exc))
        return HandlerResult.retry(reason=str(exc))
    finally:
        if not config.KEEP_TEMP_DIRS:
            _cleanup(context.workdir)

    job_log.info(
        "task completed",
        status=final_state.get("status_hint"),
        revisions=final_state.get("revision_count"),
        duration_ms=_ms(started),
    )
    write_heartbeat()
    return HandlerResult.ack(reason="completed")


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="CV tailoring queue worker")
    parser.add_argument(
        "--once",
        action="store_true",
        help="process what is currently queued, then exit (useful for CI / local POC)",
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


def start_heartbeat_thread() -> threading.Thread:
    """Keep the readiness heartbeat fresh while the worker waits for work.

    `healthcheck.py --mode readiness` (the pod's readiness probe) reads this file,
    and it used to be written only at start-up and after each task - so a worker
    that idled longer than HEARTBEAT_MAX_AGE_SECONDS reported itself unhealthy
    (readiness "heartbeat is stale"), which also made a later
    `helm upgrade --wait` fail with the pod stuck at 0/1.
    """
    interval = max(15, config.HEARTBEAT_MAX_AGE_SECONDS // 3)

    def _beat() -> None:
        while not STOP_EVENT.wait(interval):
            write_heartbeat()

    thread = threading.Thread(target=_beat, name="heartbeat", daemon=True)
    thread.start()
    return thread


def main(argv=None) -> int:
    args = parse_args(argv)
    if args.queue_backend:
        config.QUEUE_BACKEND = args.queue_backend

    setup_logging()
    log.info(
        "worker starting",
        queue_backend=config.QUEUE_BACKEND,
        db_backend=config.DB_BACKEND,
        model_state_backend=config.MODEL_STATE_BACKEND,
        queue=config.QUEUE_NAME,
        prefetch=config.PREFETCH_COUNT,
    )

    if not args.skip_preflight:
        try:
            status = preflight()
            log.info("preflight ok", **status)
        except Exception as exc:  # noqa: BLE001
            log.error("preflight failed - refusing to start", error=str(exc))
            return 2

    queue = get_queue()
    _install_signal_handlers(queue)

    max_messages = args.max_messages
    if args.once and max_messages is None:
        pending = getattr(queue, "pending_count", None)
        available = pending() if callable(pending) else (queue.depth() or 0)
        # Nothing queued: exit immediately rather than idling forever.
        max_messages = max(0, int(available))

    write_heartbeat()
    start_heartbeat_thread()
    try:
        processed = queue.consume(
            handle_delivery, max_messages=max_messages, stop_event=STOP_EVENT
        )
    finally:
        queue.close()

    log.info("worker stopped", processed=processed)
    return 0


if __name__ == "__main__":
    sys.exit(main())
