"""Tests for apps/worker/agent/verification.py and self-healing schema retry."""

from unittest import mock

from agent.gemini import _self_healing_generate
from agent.models import JobRoleExtraction, TextModificationList, TextReplacement
from agent.verification import (
    evaluate_fabrications,
    invented_technologies,
    scan_document_for_fabrications,
    self_heal_replacements,
    verify_replacement_against_cv,
)

# `Docker` is in the CV text on purpose: it used to be admitted only because the *job description*
# mentioned it, which is the crack that let `FastAPI`/`FastMCP` through on 2026-10-01.
SAMPLE_CV = """
Artem Muntianu
Senior Software Engineer
SUMMARY: Experienced engineer with 13+ years building high-traffic REST APIs using .NET Core and Python.
RELEVANT SKILLS:
Backend: .NET Core, Python, REST APIs, Microservices, Docker
Databases: MSSQL Server, Postgres, Azure
PROFESSIONAL EXPERIENCE:
Senior Software Engineer | Codify Technologies | 2025 - 2026
• Migrated 50 desktop screens and 10 WCF services (300+ endpoints across 5 repos) to .NET Core.
• Cut report generation time by 80%.
"""

# The vacancy the report came from: it asks for MCP/FastAPI, and the model claimed both.
SAMPLE_JD = """
Senior Python Engineer (MCP / Prompting). Requirements: Python, FastAPI, FastMCP, MCP servers,
prompt engineering, Docker, .NET Core, Azure, REST API design.
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


# --- 2026-10-01: a vacancy's demand is not evidence --------------------------- #

# The summary the pipeline delivered for `851224` (optico.team, "Senior Python Engineer (MCP /
# Prompting)"): FastAPI and FastMCP are in the vacancy and nowhere in the candidate's own record.
REPORTED_SUMMARY = (
    "Senior Python Engineer with hands-on expertise building reliable backend services, APIs, and "
    "AI-driven workflows using Python, FastAPI, FastMCP, and prompt engineering. Proven ability to "
    "design and maintain robust integrations, multi-agent orchestrations, and LLM-powered systems "
    "backed by solid engineering practices and Git."
)
# What the candidate facts do back: the two claims in that summary that are legitimate.
EVIDENCED_FACTS = "AI: built LLM-powered tooling and prompt engineering. Git for version control."

SUMMARY_ORIGINAL = (
    "SUMMARY: Experienced engineer with 13+ years building high-traffic REST APIs using .NET Core "
    "and Python."
)


def test_a_technology_the_vacancy_asks_for_is_not_evidence():
    """The regression itself: the JD names FastAPI/FastMCP, the CV does not, so the claim dies."""
    violations = verify_replacement_against_cv(
        SAMPLE_CV, SUMMARY_ORIGINAL, REPORTED_SUMMARY, SAMPLE_JD, EVIDENCED_FACTS
    )
    assert any("FASTAPI" in v for v in violations)
    assert any("FASTMCP" in v for v in violations)
    # ... and the violation says *why*, because "the vacancy asks for it" is the whole story.
    assert any("the vacancy asks for it" in v for v in violations)
    assert len(violations) == 2, "the JD-only skills are the only complaints"


def test_the_same_summary_is_clean_once_the_cv_really_states_it():
    evidenced = SAMPLE_CV.replace("Backend: .NET Core", "Backend: FastAPI, FastMCP, .NET Core")
    violations = verify_replacement_against_cv(
        evidenced, SUMMARY_ORIGINAL, REPORTED_SUMMARY, SAMPLE_JD, EVIDENCED_FACTS
    )
    assert violations == []


def test_a_name_the_vocabulary_cannot_know_is_caught_by_shape():
    """No list holds tomorrow's tool: an internal capital or a digit is enough to be a claim."""
    violations = verify_replacement_against_cv(
        SAMPLE_CV,
        "Backend: .NET Core, Python",
        "Backend: .NET Core, Python, PyTorch and GPT-4 pipelines",
        SAMPLE_JD,
    )
    assert any("PYTORCH" in v for v in violations)
    assert any("GPT-4" in v for v in violations)


def test_rephrasing_an_evidenced_skill_the_way_the_vacancy_spells_it_is_allowed():
    """Postgres -> PostgreSQL, .NET Core -> dotnet: the same skill, not a new claim."""
    assert invented_technologies("Databases: PostgreSQL and dotnet", SAMPLE_CV) == []


def test_prose_acronyms_are_never_read_as_technology_claims():
    """`CV`, `ATS`, `KPIs` and `OKRs` are why the shape rule needs a stop-list."""
    text = "Tailored for the ATS: this CV states KPIs and OKRs, with ROI in mind."
    assert invented_technologies(text, SAMPLE_CV) == []


def test_the_document_gate_judges_the_file_not_the_patch_list():
    """The last line of defence: what the document says is checked, not what was proposed."""
    document = SAMPLE_CV + "\n" + REPORTED_SUMMARY
    violations = scan_document_for_fabrications(document, SAMPLE_CV, EVIDENCED_FACTS)
    assert any("FASTAPI" in v for v in violations)
    assert len(violations) == 2
    assert all("produced document" in v for v in violations)


def test_a_name_and_a_heading_are_never_technology_claims():
    """Live 2026-10-02: the gate rejected a real CV for `ARTEM`, `BLOGS` and `EDUCATION`.

    Consecutive capitals satisfy the "internal capital" shape test, so an ALL-CAPS word with no
    digit is excluded - it is a name or a heading, and acronyms live in the curated vocabulary.
    """
    document = "ARTEM MUNTIANU\nSUMMARY\nEngineer.\nBLOGS\nEDUCATION\nUniversity of Nowhere."
    assert invented_technologies(document, SAMPLE_CV) == []


def test_the_gate_reads_the_master_document_as_evidence():
    """The produced file is the master CV plus the replacements, so its own words back them."""
    master = "ARTEM MUNTIANU\nBLOGS\nPython, FastAPI\nEDUCATION\nSome university"

    # Nothing was added: no violations, even though the CV *model* text lacks the name, the
    # headings and FastAPI.
    assert scan_document_for_fabrications(master, SAMPLE_CV, "", master_text=master) == []

    # A claim the master does not carry is still refused.
    added = master + "\nFastMCP and Snowflake pipelines."
    violations = scan_document_for_fabrications(added, SAMPLE_CV, "", master_text=master)
    assert any("FASTMCP" in v for v in violations)
    assert any("SNOWFLAKE" in v for v in violations)


# --- the bounded self-healing loop ------------------------------------------- #


def answer(*pairs):
    return TextModificationList(
        modifications=[
            TextReplacement(original_text=original, tailored_text=tailored, reason="test")
            for original, tailored in pairs
        ]
    )


def heal(suggest, max_retries=3):
    return self_heal_replacements(
        suggest,
        "BASE PROMPT",
        SAMPLE_CV,
        [(SUMMARY_ORIGINAL, REPORTED_SUMMARY, "r")],
        job_description=SAMPLE_JD,
        ground_truth=EVIDENCED_FACTS,
        max_retries=max_retries,
    )


def test_the_loop_stops_at_the_first_clean_answer():
    clean = "Senior Python Engineer with 13+ years building REST APIs in .NET Core and Python."
    prompts = []

    def suggest(prompt):
        prompts.append(prompt)
        return answer((SUMMARY_ORIGINAL, clean))  # the first retry is already clean

    best, attempts = heal(suggest)

    assert attempts == 1, "a clean retry ends the loop"
    assert best.violations == [] and len(best.clean_replacements) == 1
    assert "FASTAPI" in prompts[0], "the retry names exactly what the model claimed"
    assert "TARGET, never evidence" in prompts[0]


def test_the_loop_is_bounded_by_max_retries():
    calls = []

    def suggest(prompt):
        calls.append(prompt)
        return answer((SUMMARY_ORIGINAL, REPORTED_SUMMARY))  # never learns

    best, attempts = heal(suggest)

    assert attempts == 3 and len(calls) == 3, "three retries, never a fourth"
    assert best.violations, "what is left is the caller's strict filter to drop"
    assert best.clean_replacements == []


def test_a_worse_retry_never_replaces_the_draft_in_hand():
    worse = answer((SUMMARY_ORIGINAL, REPORTED_SUMMARY + " Also Kubernetes, Snowflake and Rust."))

    best, attempts = heal(lambda prompt: worse, max_retries=2)

    assert attempts == 2
    assert len(best.violations) == 2, "the two-violation draft beats the five-violation retry"


def test_a_failed_retry_keeps_the_draft_and_stops():
    def suggest(prompt):
        raise RuntimeError("model unavailable")

    best, attempts = heal(suggest)

    assert attempts == 1, "a broken retry does not spend the rest of the budget"
    assert len(best.violations) == 2
