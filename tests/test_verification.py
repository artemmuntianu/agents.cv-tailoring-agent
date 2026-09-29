"""Tests for agent/verification.py and self-healing schema retry."""

from unittest import mock

from agent.gemini import _self_healing_generate
from agent.models import JobRoleExtraction, TextReplacement
from agent.verification import evaluate_fabrications, verify_replacement_against_cv

SAMPLE_CV = """
Artem Muntianu
Senior Software Engineer
SUMMARY: Experienced engineer with 13+ years building high-traffic REST APIs using .NET Core and Python.
RELEVANT SKILLS:
Backend: .NET Core, Python, REST APIs, Microservices
Databases: MSSQL Server, Postgres, Azure
PROFESSIONAL EXPERIENCE:
Senior Software Engineer | Codify Technologies | 2025 - 2026
• Migrated 50 desktop screens and 10 WCF services (300+ endpoints across 5 repos) to .NET Core.
• Cut report generation time by 80%.
"""

SAMPLE_JD = """
Looking for Senior Backend Engineer. Requirements: Python, .NET Core, Azure, Docker, REST API design.
"""


def test_verify_replacement_clean():
    orig = "Migrated 50 desktop screens and 10 WCF services (300+ endpoints across 5 repos) to .NET Core."
    tailored = "Architected migration of 50 desktop screens and 10 WCF services (300+ endpoints across 5 repos) using .NET Core and Docker."
    violations = verify_replacement_against_cv(SAMPLE_CV, orig, tailored, SAMPLE_JD)
    assert violations == []


def test_verify_replacement_flags_invented_number():
    orig = "Migrated 50 desktop screens and 10 WCF services (300+ endpoints across 5 repos) to .NET Core."
    tailored = "Migrated 100 desktop screens and 20 WCF services (500+ endpoints across 10 repos) to .NET Core."
    violations = verify_replacement_against_cv(SAMPLE_CV, orig, tailored, SAMPLE_JD)
    # "10" exists in the CV, but 100 and 500+ are genuinely invented
    assert len(violations) >= 2
    assert any("100" in v for v in violations)
    assert any("500+" in v for v in violations)


def test_verify_replacement_flags_unlisted_technology():
    orig = "Backend: .NET Core, Python, REST APIs, Microservices"
    tailored = "Backend: .NET Core, Python, Rust, Kubernetes, Snowflake"
    violations = verify_replacement_against_cv(SAMPLE_CV, orig, tailored, SAMPLE_JD)
    assert len(violations) >= 2
    assert any("RUST" in v for v in violations)
    assert any("KUBERNETES" in v for v in violations)


def test_ground_truth_admits_a_technology_the_cv_text_does_not_state():
    """The candidate facts are evidence: Redis is real experience, the CV dump just omits it."""
    replacements = [
        TextReplacement(
            original_text="Databases: MSSQL Server, Postgres, Azure",
            tailored_text="Databases: MSSQL Server, Postgres, Azure, Redis",
            reason="the job description asks for caching",
        )
    ]
    filtered = evaluate_fabrications(SAMPLE_CV, replacements, SAMPLE_JD)
    assert filtered.clean_replacements == []
    assert any("REDIS" in v for v in filtered.violations)

    admitted = evaluate_fabrications(
        SAMPLE_CV,
        replacements,
        SAMPLE_JD,
        ground_truth="Redis and RabbitMQ experience: caching with Redis at Tangiblee.",
    )
    assert admitted.violations == []
    assert len(admitted.clean_replacements) == 1


def test_ground_truth_still_rejects_an_invented_technology():
    replacements = [
        TextReplacement(
            original_text="Backend: .NET Core, Python, REST APIs, Microservices",
            tailored_text="Backend: .NET Core, Python, Rust",
            reason="invented",
        )
    ]
    res = evaluate_fabrications(
        SAMPLE_CV,
        replacements,
        SAMPLE_JD,
        ground_truth="Redis and RabbitMQ experience: caching with Redis at Tangiblee.",
    )
    assert any("RUST" in v for v in res.violations)
    assert res.clean_replacements == []


def test_evaluate_fabrications_zero_lies_percentage():
    replacements = [
        TextReplacement(
            original_text="Senior Software Engineer",
            tailored_text="Senior Backend Engineer (.NET / Python)",
            reason="targets JD title",
        )
    ]
    res = evaluate_fabrications(SAMPLE_CV, replacements, SAMPLE_JD)
    assert res.lie_percentage == 0.0
    assert len(res.clean_replacements) == 1


def test_evaluate_fabrications_filters_lying_replacements():
    replacements = [
        TextReplacement(
            original_text="Senior Software Engineer",
            tailored_text="Senior Backend Engineer (.NET / Python)",
            reason="clean",
        ),
        TextReplacement(
            original_text="Cut report generation time by 80%.",
            tailored_text="Cut report generation time by 99% using Rust.",
            reason="fabricated",
        ),
    ]
    res = evaluate_fabrications(SAMPLE_CV, replacements, SAMPLE_JD)
    assert res.lie_percentage > 0.0
    assert len(res.clean_replacements) == 1
    assert res.clean_replacements[0].original_text == "Senior Software Engineer"


def test_self_healing_generate_succeeds_first_try():
    client = mock.Mock()
    response_mock = mock.Mock()
    response_mock.text = '{"target_role_title": "Senior Solution Architect"}'
    client.models.generate_content.return_value = response_mock

    res = _self_healing_generate(client, "gemini-3.6-flash", "extract role prompt", JobRoleExtraction)
    assert res.target_role_title == "Senior Solution Architect"
    assert client.models.generate_content.call_count == 1


def test_self_healing_generate_retries_on_schema_failure():
    client = mock.Mock()
    bad_response = mock.Mock()
    bad_response.text = '{"wrong_key": "invalid"}'

    good_response = mock.Mock()
    good_response.text = '{"target_role_title": "Senior Backend Engineer"}'

    client.models.generate_content.side_effect = [bad_response, good_response]

    res = _self_healing_generate(client, "gemini-3.6-flash", "extract role prompt", JobRoleExtraction)
    assert res.target_role_title == "Senior Backend Engineer"
    assert client.models.generate_content.call_count == 2
