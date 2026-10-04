"""The per-run log/status context every graph node binds.

One module, because all four nodes want the same three fields on every line and the same hand-off
to the job row - and because a status write must never be fatal: a local CLI run has no `job_id`,
and a DB hiccup must not kill a task that is otherwise making progress.
"""

from agent.state import State
from utils import db as db_module
from utils.logging_setup import get_logger

log = get_logger(__name__)


def job_logger(state: State):
    return log.bind(
        job_id=state.get("job_id") or "-",
        external_id=state.get("external_id") or "-",
        attempt=state.get("attempt", 0),
    )


def set_status(state: State, status: str, **extra) -> None:
    """Persist a status transition so the dashboard can pick it up.

    Never fatal: local CLI runs have no job_id and a DB hiccup must not kill a
    task that is otherwise making progress.
    """
    job_id = state.get("job_id")
    if not job_id:
        return
    try:
        db_module.get_db().update_job(job_id, status=status, **extra)
    except Exception as exc:  # noqa: BLE001
        job_logger(state).warning("could not persist job status", status=status, error=str(exc))
