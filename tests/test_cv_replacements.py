"""The rules a replacement must satisfy: one clean line, and never the read-only projects block."""

from tests.helpers import SAMPLE_CV_DATA
from utils import cv_replacements


def test_normalize_replacements_splits_concatenated_label_and_value():
    items = [("Languages\nC#, SQL", "Languages (ATS)\nC#, SQL, Azure")]
    result = cv_replacements.normalize_replacements(items)
    assert result == [
        ("Languages", "Languages (ATS)", "N/A"),
        ("C#, SQL", "C#, SQL, Azure", "N/A"),
    ]


def test_normalize_replacements_drops_misaligned_lines_bullets_and_noops():
    items = [
        ("a\nb", "only-one-line"),  # cannot align -> dropped
        ("• Led the migration", "• Led the migration"),  # no-op -> dropped
        ("• Cut report generation time by 80%.", "Cut report time by 80%.", "ATS keyword"),
    ]
    result = cv_replacements.normalize_replacements(items)
    assert result == [("Cut report generation time by 80%.", "Cut report time by 80%.", "ATS keyword")]


def test_read_only_replacements_leave_the_projects_block_alone():
    """A project line (or a fragment of one) is never a replacement target."""
    project = SAMPLE_CV_DATA["personal_projects"][0]
    summary = (SAMPLE_CV_DATA["summary"], "Platform Engineering Lead with Azure delivery record.")
    replacements = [
        summary,
        (project["heading"], "1) Hacked heading"),
        (project["description"], "Hacked description"),
        ("Shipped a queue-backed ingestion pipeline using RabbitMQ", "Hacked bullet"),
        ("RabbitMQ, Kubernetes, Postgres.", "Rust, nothing else"),
        (project["stack"], "Rust, nothing else"),
    ]
    assert cv_replacements.drop_read_only_replacements(replacements, SAMPLE_CV_DATA) == [summary]


def test_read_only_replacements_are_a_noop_without_projects():
    """An older cv_data.json (no projects block) keeps every replacement."""
    replacements = [(SAMPLE_CV_DATA["summary"], "New summary")]
    assert cv_replacements.drop_read_only_replacements(replacements, {"summary": "x"}) == replacements
