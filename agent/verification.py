"""Deterministic verification loop for detecting hallucinations ("lies") in tailored CV text.

Evaluates proposed replacements against the candidate's original CV text and job description
to guarantee that the percentage of fabricated metrics, numbers, or unlisted tech stacks is strictly 0%.
"""

import re
from typing import NamedTuple

from utils.logging_setup import get_logger

log = get_logger(__name__)

# Pattern for numbers, metrics, percentages, and numeric multipliers (e.g. 50%, 2B+, 300+, $5000, 13+)
NUMERIC_PATTERN = re.compile(r"\b(?:\$\d+|\d+(?:\.\d+)?%?|\d+[BKM]\+?|\d+\+)\b", re.IGNORECASE)

# Pattern for specific technology stack keywords, frameworks, databases, tools and languages
TECH_PATTERN = re.compile(
    r"\b(?:\.[Nn][Ee][Tt]|C#|C\+\+|CI/CD|REST|API|APIM|WCF|WPF|SQL|NoSQL|gRPC|GraphQL|"
    r"Kafka|RabbitMQ|Docker|Kubernetes|AKS|EKS|AWS|GCP|Azure|OpenAI|Anthropic|DeepSeek|LLM|RAG|"
    r"CQRS|ADR|HLD|LLD|JWT|OAuth2|OIDC|Playwright|Jest|Angular|React|Next\.js|Astro|Vue|Node\.js|"
    r"Python|Java|Golang|TypeScript|JavaScript|Postgres|MSSQL|MongoDB|Redis|Rust|Go|C\+\+|"
    r"Spark|Hadoop|Snowflake|Terraform|Ansible|Jenkins|Git|GitHub|GitLab|Linux|Unix|Windows|"
    r"Cassandra|Elasticsearch|DynamoDB|Firebase|Supabase|Microservices|Serverless|WinForms)\b",
    re.IGNORECASE,
)

# Common action verbs and general vocabulary to exclude from custom keyword matching
ACTION_VERBS = {
    "Architected", "Engineered", "Designed", "Developed", "Led", "Built", "Managed",
    "Formulated", "Contributed", "Created", "Implemented", "Owned", "Migrated",
    "Delivered", "Optimized", "Pioneered", "Researched", "Orchestrated", "Provided",
    "Selected", "Supervised", "Collaborated", "Transformed", "Established", "Executed",
    "Maintained", "Integrated", "Authoring", "Authored", "Refactored", "Scaling", "Scaled"
}


class FabricationCheckResult(NamedTuple):
    lie_percentage: float
    total_tokens: int
    fabricated_count: int
    violations: list[str]
    clean_replacements: list


def _normalize_text(text: str) -> str:
    """Normalize text for token matching (lower case, standardized spaces and dashes)."""
    clean = text.lower().replace("\xa0", " ").replace("–", "-").replace("—", "-")
    return " ".join(clean.split())


def extract_numbers(text: str) -> set[str]:
    """Extract all numeric quantities, percentages, and metrics from text."""
    return set(m.group(0).lower() for m in NUMERIC_PATTERN.finditer(text))


def extract_tech_keywords(text: str) -> set[str]:
    """Extract technology names and tech stack terms from text."""
    matches = TECH_PATTERN.findall(text)
    return set(m.upper() for m in matches if m not in ACTION_VERBS)


def verify_replacement_against_cv(
    cv_text: str, original_text: str, tailored_text: str, job_description: str = "",
    ground_truth: str = "",
) -> list[str]:
    """Check a single replacement for numeric or unlisted tech stack fabrications.

    `ground_truth` is the candidate-facts block (the operator's own profile: availability,
    years per stack, caching/messaging used, ...). It is admissible evidence about the
    candidate's real experience, so a technology or a number it states is not a
    fabrication - while anything stated nowhere is still a violation.

    Returns a list of violation description strings (empty if clean).
    """
    violations = []
    norm_cv = _normalize_text(cv_text)
    norm_jd = _normalize_text(job_description)
    norm_facts = _normalize_text(ground_truth)

    # 1. Numeric & Metric Verification: Every number in tailored text MUST exist in the source CV
    orig_numbers = extract_numbers(original_text)
    tailored_numbers = extract_numbers(tailored_text)

    for num in tailored_numbers:
        if num not in orig_numbers and num not in norm_cv and num not in norm_facts:
            violations.append(f"Invented or altered metric/number '{num}' in tailored text: '{tailored_text}'")

    # 2. Technology & Tool Claim Verification: Every tech claim MUST exist in CV or Job Description
    orig_tech = set(t.lower() for t in extract_tech_keywords(cv_text))
    jd_tech = set(t.lower() for t in extract_tech_keywords(job_description))
    tailored_tech = extract_tech_keywords(tailored_text)

    for tech in tailored_tech:
        norm_tech = tech.lower()
        if (
            norm_tech not in orig_tech
            and norm_tech not in norm_cv
            and norm_tech not in jd_tech
            and norm_tech not in norm_jd
            and norm_tech not in norm_facts
        ):
            violations.append(f"Unlisted technology claim '{tech}' found in tailored text (absent from both CV and JD)")

    return violations


def evaluate_fabrications(
    cv_text: str, replacements: list, job_description: str = "", ground_truth: str = ""
) -> FabricationCheckResult:
    """Evaluate a list of replacement objects or tuples against the master CV text and JD.

    `ground_truth` narrows nothing and widens the admissible sources only (see
    `verify_replacement_against_cv`): it is the candidate facts the tailoring prompt already
    carries, so a replacement backed by them must not be filtered out as a lie.

    Returns FabricationCheckResult with exact lie_percentage, violations, and clean_replacements.
    """
    violations = []
    clean_replacements = []
    total_tailored_tokens = 0
    fabricated_count = 0

    for item in replacements:
        if hasattr(item, "original_text"):
            orig_text = item.original_text
            tail_text = item.tailored_text
        elif isinstance(item, (tuple, list)):
            orig_text = item[0]
            tail_text = item[1]
        else:
            continue

        tokens = len(tail_text.split())
        total_tailored_tokens += max(1, tokens)

        item_violations = verify_replacement_against_cv(
            cv_text, orig_text, tail_text, job_description, ground_truth
        )
        if item_violations:
            fabricated_count += len(item_violations)
            violations.extend(item_violations)
            log.warning(
                "fabrication detected in LLM replacement",
                original=orig_text,
                tailored=tail_text,
                violations=item_violations,
            )
        else:
            clean_replacements.append(item)

    lie_percentage = (
        0.0 if total_tailored_tokens == 0 else round((fabricated_count / total_tailored_tokens) * 100.0, 2)
    )

    return FabricationCheckResult(
        lie_percentage=lie_percentage,
        total_tokens=total_tailored_tokens,
        fabricated_count=fabricated_count,
        violations=violations,
        clean_replacements=clean_replacements,
    )
