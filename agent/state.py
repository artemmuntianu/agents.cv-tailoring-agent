from typing import Any, TypedDict


class State(TypedDict):
    """LangGraph state.

    The first block is the original local-only contract (unchanged), the second
    block carries the cloud/queue context so a run can be traced, persisted and
    uploaded.
    """

    # --- local pipeline (unchanged) ------------------------------------- #
    cv_path: str
    job_description: str
    output_path: str
    temp_dir: str
    target_role_title: str
    current_cv_text: str
    modifications: list[dict[str, str]]
    layout_feedback: str
    revision_count: int
    image_paths: list[str]
    is_approved: bool

    # --- cloud / worker context ----------------------------------------- #
    job_id: str
    user_id: str
    external_id: str
    cv_version: str
    cv_data: dict[str, Any]
    attempt: int
    title: str
    company: str
    source_url: str
    skip_cv_sync_check: bool
    pdf_path: str
    pdf_url: str
    docx_url: str
    status_hint: str
    started_at: str
    finished_at: str


def initial_state(**overrides) -> State:
    """Build a fully populated state so nodes can rely on every key existing."""
    state: dict[str, Any] = {
        "cv_path": "",
        "job_description": "",
        "output_path": "",
        "temp_dir": "",
        "target_role_title": "",
        "current_cv_text": "",
        "modifications": [],
        "layout_feedback": "",
        "revision_count": 0,
        "image_paths": [],
        "is_approved": False,
        "job_id": "",
        "user_id": "",
        "external_id": "",
        "cv_version": "v1",
        "cv_data": {},
        "attempt": 0,
        "title": "",
        "company": "",
        "source_url": "",
        "skip_cv_sync_check": False,
        "pdf_path": "",
        "pdf_url": "",
        "docx_url": "",
        "status_hint": "",
        "started_at": "",
        "finished_at": "",
    }
    state.update(overrides)
    return state  # type: ignore[return-value]
