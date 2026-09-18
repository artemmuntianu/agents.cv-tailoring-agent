"""Message contract + DB helper tests."""

import pytest
from pydantic import ValidationError

from agent.contracts import JobStatus, ResumeTaskMessage
from tests.helpers import SAMPLE_CV_DATA, sample_task
from utils.db import job_key, new_job_id


def test_task_parses_minimal_payload_and_defaults():
    task = ResumeTaskMessage.model_validate(
        {"external_id": "848944", "description_raw": "About the Role"}
    )
    assert task.external_id == "848944"
    assert task.cv_version == "v1"
    assert task.attempt == 0
    assert task.cv_data is None
    assert task.job_id  # generated


def test_task_job_key_is_stable_per_vacancy_and_cv_version():
    first = ResumeTaskMessage.model_validate(sample_task(user_id="user-1"))
    second = ResumeTaskMessage.model_validate(sample_task(user_id="user-1"))
    other_version = ResumeTaskMessage.model_validate(
        sample_task(user_id="user-1", cv_version="v2")
    )
    assert first.key() == second.key()
    assert first.key() != other_version.key()
    assert first.key() == job_key("user-1", "848944", "v1")


def test_task_accepts_inline_cv_data_and_serialises_job_row():
    task = ResumeTaskMessage.model_validate(sample_task(include_cv_data=True))
    assert task.cv_data_dict()["summary"] == SAMPLE_CV_DATA["summary"]

    row = task.to_job_row(JobStatus.PROCESSING)
    assert row["status"] == "processing"
    assert row["external_id"] == "848944"
    assert row["job_id"] == task.job_id


def test_missing_required_fields_are_rejected():
    with pytest.raises(ValidationError):
        ResumeTaskMessage.model_validate({"description_raw": "no external id"})


def test_new_job_id_is_unique():
    assert new_job_id() != new_job_id()


def test_job_id_is_an_opaque_validated_string():
    """Option A: any publisher may bring its own id - but it must be sane."""
    readable = ResumeTaskMessage.model_validate(
        {"job_id": "848944-1789668742", "external_id": "1", "description_raw": "x"}
    )
    assert readable.job_id == "848944-1789668742"

    uuid_like = ResumeTaskMessage.model_validate(
        {
            "job_id": "3f0f2a7c-9c6b-4f1e-8a7d-1b2c3d4e5f60",
            "external_id": "1",
            "description_raw": "x",
        }
    )
    assert uuid_like.job_id.startswith("3f0f2a7c")

    for bad in ("has spaces/slash", "ab", "x" * 81):
        with pytest.raises(ValidationError):
            ResumeTaskMessage.model_validate(
                {"job_id": bad, "external_id": "1", "description_raw": "x"}
            )
