"""The CV model as text: rendering (including the read-only projects block) and loading."""

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
    assert "PERSONAL PROJECTS:" in text
    assert SAMPLE_CV_DATA["personal_projects"][0]["heading"] in text
    assert "• Shipped a queue-backed ingestion pipeline using RabbitMQ." in text
    assert "Repo: https://example.invalid/analytics" in text
    assert "Stack: Python, RabbitMQ, Kubernetes, Postgres." in text


def test_extract_doc_text_accepts_cv_data_and_legacy_path():
    from_data = cv_text.extract_doc_text(SAMPLE_CV_DATA)
    assert from_data.startswith(SAMPLE_CV_DATA["header"]["title"])

    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            # Legacy call style: a bare path string used to be accepted.
            via_path = cv_text.extract_doc_text(os.path.join(tmp, "whatever.docx"))
    assert via_path == from_data
