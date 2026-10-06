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
    """One role of the master CV (`professional_experience`).

    The refactored master CV lays a role out as a two-cell row - the role and its context in the
    left cell, the period and the employer in the right one - so those are four separate DOCX
    paragraphs and therefore four separate single-line fields. The whole block is **read-only
    context** (only the title, the summary and the skills are tailored; see
    `utils.cv_replacements.drop_read_only_replacements`), and
    `utils.docx_mutator.validate_cv_data_against_docx()` is a verbatim per-line substring test, so a
    value that is not a line of the document fails the task.
    """

    model_config = ConfigDict(extra="allow")

    role: str
    company_info: str = ""
    context: str = ""
    dates: str = ""
    highlights: list[str] = Field(default_factory=list)


class CvProject(BaseModel):
    """One project of the master CV (`personal_projects`; the document's *PET PROJECTS* block).

    `heading`, `year` and `stack` are stored verbatim, one field per DOCX paragraph, because the
    sync rule is a verbatim per-line substring test against the document (invariant 5). The whole
    block is context for the SUMMARY/SKILLS rewrites; see
    `utils.cv_replacements.drop_read_only_replacements`.
    """

    model_config = ConfigDict(extra="allow")

    heading: str
    year: str = ""
    description: str = ""
    highlights: list[str] = Field(default_factory=list)
    links: list[str] = Field(default_factory=list)
    stack: str = ""


class CvData(BaseModel):
    """Structured CV knowledge base (`cv_data.json`)."""

    model_config = ConfigDict(extra="allow")

    header: CvHeader
    summary: str
    skills: dict[str, str] = Field(default_factory=dict)
    professional_experience: list[CvExperience] = Field(default_factory=list)
    personal_projects: list[CvProject] = Field(default_factory=list)


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
    source: str = Field(
        default="djinni",
        pattern=r"^[a-z0-9][a-z0-9-]{1,31}$",
        description=(
            "Slug of the site the vacancy came from ('djinni', 'dou', 'greenhouse'). Part of the "
            "idempotency key: two sites number their vacancies independently."
        ),
    )
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
        return job_key(self.user_id, self.external_id, self.cv_version, self.source)

    def cv_data_dict(self) -> dict[str, Any] | None:
        return self.cv_data.model_dump() if self.cv_data is not None else None

    def to_job_row(self, status: str = JobStatus.QUEUED) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "user_id": self.user_id,
            "external_id": self.external_id,
            "source": self.source,
            "title": self.title,
            "company": self.company,
            "source_url": self.source_url,
            "description_raw": self.description_raw,
            "cv_version": self.cv_version,
            "status": status,
            "attempts": self.attempt,
        }

    @classmethod
    def from_delivery(cls, payload: dict) -> "ResumeTaskMessage":
        return cls.model_validate(payload)


class CoverLetterMessage(BaseModel):
    """One cover-letter request, published when the operator asks for one.

    Deliberately tiny: the vacancy's description lives in the database
    (`resumes.description_raw`) and the master CV on the volume, so the payload carries no
    copy of either - a stale copy could otherwise reach the prompt and let the letter claim
    something the CV does not say.
    """

    model_config = ConfigDict(extra="allow")

    job_id: str = Field(
        min_length=4,
        max_length=80,
        pattern=r"^[A-Za-z0-9_.:-]+$",
        description="Row id of the vacancy the letter is for (`resumes.job_id`).",
    )
    attempt: int = 0
    enqueued_at: str | None = None


class RerenderMessage(BaseModel):
    """One *Update docx* request: the operator uploaded a hand-edited deliverable.

    As tiny as the cover-letter message, and for the same reason - the file itself is in the
    database row (`resume_docx_update.content`) rather than in the payload. A broker message that
    carried a megabyte of DOCX would be a message nobody can read in the RabbitMQ UI, and the
    redelivery the broker promises would copy the bytes again.
    """

    model_config = ConfigDict(extra="allow")

    job_id: str = Field(
        min_length=4,
        max_length=80,
        pattern=r"^[A-Za-z0-9_.:-]+$",
        description="Row id of the vacancy whose deliverable was replaced (`resumes.job_id`).",
    )
    attempt: int = 0
    enqueued_at: str | None = None


class ApplicationField(BaseModel):
    """One fillable control the extension annotated in the rendered page.

    The `id` is **minted by the extension** (`data-cvt-id="f1"`, ...), never by the model: the
    plan refers to that id, so a hallucinated element path cannot happen - the extension resolves
    the id back to the element it annotated. `options` is set for a select/radio group and carries
    the visible labels the answer has to choose between.
    """

    model_config = ConfigDict(extra="ignore")

    id: str = Field(
        min_length=1,
        max_length=24,
        pattern=r"^[A-Za-z0-9_-]+$",
        description="The extension's own annotation id (`data-cvt-id`).",
    )
    kind: str = Field(default="text", max_length=32)
    label: str = Field(default="", max_length=500)
    name: str = Field(default="", max_length=200)
    placeholder: str = Field(default="", max_length=300)
    required: bool = False
    hidden: bool = Field(
        default=False,
        description="Rendered but not visible (a value the site pre-fills behind a toggle).",
    )
    options: list[str] = Field(default_factory=list, max_length=40)


class ApplicationFormSnapshot(BaseModel):
    """The rendered application form as the extension saw it.

    `html` is the annotated, trimmed subtree (scripts/styles/hidden inputs removed, every
    fillable control carrying its `data-cvt-id`), so the model can read the questions and the
    section headings but cannot see anything else on the page.
    """

    model_config = ConfigDict(extra="ignore")

    root: str = Field(default="", max_length=500)
    html: str = Field(min_length=1, max_length=200_000)
    fields: list[ApplicationField] = Field(default_factory=list, max_length=80)


class ApplicationDraftMessage(BaseModel):
    """One application-draft request, published when the operator hits *Populate*.

    Deliberately carries **no documents**: the cover letter and the tailored PDF are inserted
    locally by the extension, from the board, and this message only asks which elements they
    belong in. The vacancy is read from the database (`resumes.description_raw`) and the candidate
    facts from the `application_profile` row, so a stale copy can never reach the prompt.
    """

    model_config = ConfigDict(extra="allow")

    job_id: str = Field(
        min_length=4,
        max_length=80,
        pattern=r"^[A-Za-z0-9_.:-]+$",
        description="Row id of the vacancy the form belongs to (`resumes.job_id`).",
    )
    schema_hash: str = Field(
        default="",
        max_length=80,
        description="Hash of the rendered form (+ the candidate file), i.e. the cache key.",
    )
    url: str = Field(default="", max_length=1000)
    host: str = Field(default="", max_length=200)
    form: ApplicationFormSnapshot
    attempt: int = 0
    enqueued_at: str | None = None


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
