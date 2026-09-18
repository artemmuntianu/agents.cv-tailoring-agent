"""Shared task runner.

Both entry points (`main.py` for local batches, `worker.py` for queue messages)
go through here, so the LangGraph invocation is identical locally and in the
cluster.
"""

import os
import time

import config
from agent.contracts import ResumeTaskMessage
from agent.graph import create_graph
from agent.state import State, initial_state
from utils.logging_setup import get_logger, utc_now_iso, write_heartbeat
from utils.model_state import init_model_state

log = get_logger(__name__)


def run_cv_tailoring(
    cv_path: str,
    job_description: str,
    output_path: str,
    temp_dir: str,
    cv_data=None,
    context: dict | None = None,
    init_models: bool = True,
) -> State:
    """Run the tailoring graph once and return the final state."""
    os.makedirs(temp_dir, exist_ok=True)

    if not os.path.exists(cv_path):
        raise FileNotFoundError(f"resume file not found at {cv_path}")

    context = dict(context or {})
    job_id = context.get("job_id") or ""

    state = initial_state(
        cv_path=cv_path,
        job_description=job_description,
        output_path=output_path,
        temp_dir=temp_dir,
        cv_data=cv_data or {},
        job_id=job_id,
        user_id=context.get("user_id") or "",
        external_id=context.get("external_id") or "",
        cv_version=context.get("cv_version") or "v1",
        attempt=int(context.get("attempt") or 0),
        title=context.get("title") or "",
        company=context.get("company") or "",
        source_url=context.get("source_url") or "",
        skip_cv_sync_check=bool(context.get("skip_cv_sync_check")),
        started_at=utc_now_iso(),
    )

    # Restore persistence: resume from the last known-good model and skip models
    # that recently failed, so we don't waste retries on a rate-limited model.
    # The ledger is shared (Postgres) in the cluster, so parallel pods agree.
    if init_models:
        init_model_state()

    started = time.time()
    graph = create_graph()
    final_state = graph.invoke(state)
    elapsed = time.time() - started

    finished = {**final_state, "finished_at": utc_now_iso()}
    log.info(
        "pipeline finished",
        job_id=job_id or "-",
        output_path=finished.get("output_path"),
        approved=finished.get("is_approved"),
        revisions=finished.get("revision_count"),
        elapsed_seconds=round(elapsed, 2),
        model=config.MODEL_NAME,
    )
    write_heartbeat()
    return finished


def run_task(
    task: ResumeTaskMessage,
    cv_path: str,
    cv_data,
    output_path: str,
    temp_dir: str,
    job_id: str | None = None,
) -> State:
    """Run the pipeline for one queue message.

    `job_id` overrides the message's id with the *database row id* actually
    claimed for this task (a retry reuses the row left by the failed attempt, so
    every status write must target that row).
    """
    return run_cv_tailoring(
        cv_path=cv_path,
        job_description=task.description_raw,
        output_path=output_path,
        temp_dir=temp_dir,
        cv_data=cv_data,
        context={
            "job_id": job_id or task.job_id,
            "user_id": task.user_id,
            "external_id": task.external_id,
            "cv_version": task.cv_version,
            "attempt": task.attempt,
            "title": task.title,
            "company": task.company,
            "source_url": task.source_url,
        },
    )
