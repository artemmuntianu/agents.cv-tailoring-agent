"""`persist`: the terminal node - upload the artifacts, then write the final row.

The queue message is acked only after this node returns, so a crash redelivers the task instead of
losing the result (invariant 2). It sits in its own module because it is the only node that talks
to storage and owns the row's durability fields - nothing about the adaptation itself.
"""

import os
from datetime import datetime
from types import SimpleNamespace

from agent.contracts import JobStatus
from agent.job_log import job_logger, set_status
from agent.state import State
from utils import candidate as candidate_module
from utils import db as db_module
from utils import storage as storage_module
from utils.logging_setup import get_logger

log = get_logger(__name__)


def persist(state: State) -> State:
    """Terminal node: upload artifacts and write the final row.

    The message is only acked after this node returns, so a crash here simply
    re-delivers the task instead of losing the result.
    """
    job_log = job_logger(state)
    job_log.info("node started", node="persist")
    set_status(state, JobStatus.UPLOADING)

    status = state.get("status_hint") or JobStatus.COMPLETED
    pdf_url = state.get("pdf_url") or ""
    docx_url = state.get("docx_url") or ""

    if state.get("job_id"):
        task = SimpleNamespace(
            job_id=state.get("job_id"),
            user_id=state.get("user_id") or None,
            external_id=state.get("external_id") or "cv",
        )
        storage = storage_module.get_storage()
        # Whose CV this is, for the artifact name (`artemmuntianu-852417.pdf`), read here because this
        # is the only node that names one.
        name = candidate_module.full_name(db_module.get_db(), task.user_id)
        pdf_path = state.get("pdf_path")
        if pdf_path and os.path.exists(pdf_path):
            pdf_url = storage.upload(
                pdf_path, storage_module.output_key_for(task, ".pdf", name)
            )
        if state.get("output_path") and os.path.exists(state["output_path"]):
            docx_url = storage.upload(
                state["output_path"], storage_module.output_key_for(task, ".docx", name)
            )

    duration_ms = None
    if state.get("started_at"):
        try:
            started = datetime.fromisoformat(state["started_at"])
            duration_ms = int((datetime.now(started.tzinfo) - started).total_seconds() * 1000)
        except Exception:  # noqa: BLE001
            duration_ms = None

    set_status(
        state,
        status,
        revision_count=state.get("revision_count"),
        is_approved=bool(state.get("is_approved")),
        pdf_url=pdf_url or None,
        docx_path=docx_url or None,
        duration_ms=duration_ms,
    )
    job_log.info(
        "job finished",
        status=status,
        pdf_url=pdf_url,
        duration_ms=duration_ms,
        revisions=state.get("revision_count"),
    )

    return {
        **state,
        "pdf_url": pdf_url,
        "docx_url": docx_url,
        "status_hint": status,
    }
