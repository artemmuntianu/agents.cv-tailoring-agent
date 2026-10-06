"""The CV model as text: rendering (experience + the read-only projects block) and loading."""

import os
import tempfile

from tests.helpers import SAMPLE_CV_DATA, isolated_config
from utils import cv_text


def test_cv_data_to_text_contains_every_section():
    text = cv_text.cv_data_to_text(SAMPLE_CV_DATA)
    assert "SUMMARY:" in text
    assert "RELEVANT SKILLS:" in text
    assert "PROFESSIONAL EXPERIENCE:" in text
    assert "Languages" in text
    assert "• Led the migration of 50 desktop screens to a web platform." in text
    # The projects block is rendered too (read-only context for SUMMARY and SKILLS).
    assert "PET PROJECTS:" in text
    assert SAMPLE_CV_DATA["personal_projects"][0]["heading"] in text
    assert "• Shipped a queue-backed ingestion pipeline using RabbitMQ." in text
    assert "Repo: https://example.invalid/analytics" in text
    # The labels and the body order are the document's own: bullets, then the stack, then the links.
    assert "Key Highlights:" in text
    assert "Tech Stack:" in text
    project = SAMPLE_CV_DATA["personal_projects"][0]
    assert f"\n{project['year']}\n" in text
    assert f"\n{project['stack']}\n" in text


def test_cv_data_to_text_renders_four_lines_per_experience_entry():
    """The document splits a role into role + context | period + employer: four targets, not one."""
    text = cv_text.cv_data_to_text(SAMPLE_CV_DATA)
    experience = SAMPLE_CV_DATA["professional_experience"][0]
    for key in ("role", "company_info", "context", "dates"):
        assert f"\n{experience[key]}\n" in text
    # The old composite "company | context | period" line is gone for good.
    assert experience["company_info"] + " | " not in text


def test_experience_lines_matches_the_rendered_dump():
    """`experience_lines()` returns the very lines `cv_data_to_text()` emits (four + its bullets),
    because the read-only guard compares those lines to keep the block out of the replacement set."""
    experience = SAMPLE_CV_DATA["professional_experience"][0]
    assert cv_text.experience_lines(experience) == [
        experience["role"],
        experience["company_info"],
        experience["context"],
        experience["dates"],
        "• Led the migration of 50 desktop screens to a web platform.",
        "• Cut report generation time by 80%.",
    ]


def test_extract_doc_text_accepts_cv_data_and_legacy_path():
    from_data = cv_text.extract_doc_text(SAMPLE_CV_DATA)
    assert from_data.startswith(SAMPLE_CV_DATA["header"]["title"])

    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            # Legacy call style: a bare path string used to be accepted.
            via_path = cv_text.extract_doc_text(os.path.join(tmp, "whatever.docx"))
    assert via_path == from_data
