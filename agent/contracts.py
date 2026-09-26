"""Wire contracts for the event-driven pipeline.

`ResumeTaskMessage` is exactly the payload the Vercel API gateway publishes to
the `resumes.generate` queue (one message per vacancy): the raw job description
plus the structured CV knowledge base, which must stay in sync with the master
`cv.docx` (see `utils.docx_mutator.validate_cv_data_against_docx`).
"""

import uuid
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from utils.db import job_key


class JobStatus:
    """Values written to `resumes.status` (string constants, not an enum, so the
    payload stays trivially JSON-serialisable and dashboard-friendly).

    All but `SUBMITTED` are written by the worker. `SUBMITTED` is the one status the
    *ingest* side writes (`backoffice` batch gateway): it creates a vacancy's row
    before publishing, so the card is on the board the moment a page is scraped rather
    than only after KEDA boots a worker. It is deliberately **not** in
    `utils.db.ACTIVE_STATUSES` - the worker's claim finds such a row by business key
    and *adopts* it (same `job_id`, status -> `processing`) instead of treating the
    message as a duplicate delivery.
    """

    SUBMITTED = "submitted"
    QUEUED = "queued"
    PROCESSING = "processing"
    RENDERING = "rendering"
    VALIDATING = "validating"
    UPLOADING = "uploading"
    COMPLETED = "completed"
    SKIPPED = "skipped"
    FAILED = "failed"
    RATE_LIMITED = "rate_limited"
    DEAD_LETTERED = "dead_lettered"


class CvHeader(BaseModel):
    model_config = ConfigDict(extra="allow")

    title: str = Field(description="Header title line of the master CV.")
    name: str | None = None


class CvExperience(BaseModel):
    model_config = ConfigDict(extra="allow")

    role: str
    company_info: str = ""
    highlights: list[str] = Field(default_factory=list)


class CvData(BaseModel):
    """Structured CV knowledge base (`cv_data.json`)."""

    model_config = ConfigDict(extra="allow")

    header: CvHeader
    summary: str
    skills: dict[str, str] = Field(default_factory=dict)
    professional_experience: list[CvExperience] = Field(default_factory=list)


class ResumeTaskMessage(BaseModel):
    """One atomic task: tailor the master CV for one vacancy."""

    model_config = ConfigDict(extra="allow")

    # Opaque row identity ("option A"): any publisher may bring its own id as
    # long as it is unique and matches the DB shape guard. Omitted -> generated.
    job_id: str = Field(
        default_factory=lambda: str(uuid.uuid4()),
        min_length=4,
        max_length=80,
        pattern=r"^[A-Za-z0-9_.:-]+$",
        description="Opaque task/row id; NOT required to be a UUID.",
    )
    user_id: str | None = None
    external_id: str = Field(description="Vacancy id from the source site (e.g. 848944).")
    title: str = ""
    company: str = ""
    source_url: str | None = None
    description_raw: str = Field(description="Plain-text job description, HTML stripped.")
    cv_data: CvData | None = Field(
        default=None, description="Optional inline CV model; downloaded when absent."
    )
    cv_version: str = "v1"
    attempt: int = 0
    enqueued_at: str | None = None

    # -- helpers ----------------------------------------------------------- #
    def key(self) -> str:
        """Idempotency key (same vacancy + same master CV => same work)."""
        return job_key(self.user_id, self.external_id, self.cv_version)

    def cv_data_dict(self) -> dict[str, Any] | None:
        return self.cv_data.model_dump() if self.cv_data is not None else None

    def to_job_row(self, status: str = JobStatus.QUEUED) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "user_id": self.user_id,
            "external_id": self.external_id,
            "title": self.title,
            "company": self.company,
            "source_url": self.source_url,
            "cv_version": self.cv_version,
            "status": status,
            "attempts": self.attempt,
        }

    @classmethod
    def from_delivery(cls, payload: dict) -> "ResumeTaskMessage":
        return cls.model_validate(payload)


class TaskResult(BaseModel):
    """Outcome of one task, as persisted and pushed to the dashboard."""

    model_config = ConfigDict(extra="allow")

    job_id: str
    status: str
    pdf_url: str | None = None
    docx_url: str | None = None
    revision_count: int = 0
    is_approved: bool = False
    duration_ms: int | None = None
    error: str | None = None
