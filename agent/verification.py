"""Deterministic verification of tailored CV text - the "0% lies" rule, enforced.

Two questions, one answer: **is every claim in the produced text backed by evidence?** The
evidence is the master CV text and the operator's candidate facts (`CONSTITUTION.md` invariants 7,
31, 33). The **job description is a target, never evidence**: a vacancy demanding FastAPI does not
mean the candidate has used it, so a technology the vacancy names is *dropped*, never surfaced.

That distinction is the point of this module, and it was lost on 2026-10-01 - a JD asking for
`FastAPI`/`FastMCP` made both claims "verified" (the job description was one of the admissible
sources), and neither token was in the vocabulary the check looked for either, so both reached a
delivered CV. Two fixes live here: the sources are only ever the CV text and the candidate facts,
and detection is vocabulary *plus shape* - no list can contain tomorrow's tool, so a name with an
internal capital (`FastAPI`, `FastMCP`, `PyTorch`) or a digit (`GPT-4`, `n8n`) counts as a
technology claim too.

`self_heal_replacements` is what responds to a violation: it hands the offending answer back to
the model with the violations spelled out, up to `max_retries` times, keeps the best draft it saw
and never lets a worse retry replace a better one.
"""

import re
from typing import NamedTuple

from utils.logging_setup import get_logger

log = get_logger(__name__)

# Pattern for numbers, metrics, percentages, and numeric multipliers (e.g. 50%, 2B+, 300+, $5000, 13+)
NUMERIC_PATTERN = re.compile(r"\b(?:\$\d+|\d+(?:\.\d+)?%?|\d+[BKM]\+?|\d+\+)\b", re.IGNORECASE)

# The curated vocabulary: the stacks this pipeline is asked to tailor for. It cannot be complete -
# that is exactly how `FastAPI`/`FastMCP` slipped through - so it is only the first of two
# detectors; `SHAPE_PATTERN` below catches the names no list can know. Entries may be phrases
# (`azure service bus`), because the claim is the phrase, not the words in it.
TECH_VOCABULARY = frozenset(
    {
        # languages and runtimes
        "python", "javascript", "typescript", "java", "kotlin", "golang", "go", "rust", "php",
        "ruby", "scala", "c#", "c++", "sql", "bash", "powershell", "vba", "pyspark",
        # the Python/AI ecosystem (the 2026-10-01 gap)
        "fastapi", "fastmcp", "mcp", "flask", "django", "celery", "sqlalchemy", "pydantic",
        "uvicorn", "gunicorn", "httpx", "aiohttp", "pytest", "poetry", "langchain", "langgraph",
        "llamaindex", "haystack", "openai", "anthropic", "gemini", "ollama", "pgvector", "faiss",
        "chroma", "rag", "llm", "embeddings", "prompt engineering", "agentic",
        "pandas", "numpy", "scipy", "airflow", "prefect", "temporal", "dagster",
        # data
        "postgres", "postgresql", "mysql", "mssql", "sql server", "mongodb", "redis", "cassandra",
        "elasticsearch", "dynamodb", "sqlite", "snowflake", "bigquery", "spark", "hadoop", "etl",
        # infrastructure and tooling
        "docker", "kubernetes", "aks", "eks", "gke", "terraform", "ansible", "jenkins",
        "github actions", "gitlab ci", "git", "github", "gitlab", "linux", "unix", "windows",
        "azure", "aws", "gcp", "serverless", "microservices", "grpc", "graphql", "rest", "api",
        "kafka", "rabbitmq", "azure service bus", "event grid", "nginx", "grafana", "prometheus",
        "opentelemetry", "sentry", "supabase", "firebase", "ci/cd",
        # web, and the patterns this domain names
        "angular", "react", "next.js", "vue", "astro", "node.js", "playwright", "jest",
        "cqrs", "adr", "hld", "lld", "jwt", "oauth2", "oidc", "wcf", "wpf", "winforms", ".net",
        "ai", "ml", "nlp",
    }
)

# Spellings that name the same technology. A skill the evidence states *may* be surfaced in the
# spelling the vacancy uses - that is rephrasing, not a claim - so both sides are canonicalised
# before they are compared.
TECH_ALIASES = {
    "postgres": "postgresql",
    "psql": "postgresql",
    "mssql": "sql server",
    "ms sql": "sql server",
    "sqlserver": "sql server",
    ".net": "dotnet",
    "dotnet": "dotnet",
    "asp.net": "dotnet",
    ".net core": "dotnet",
    "node.js": "nodejs",
    "nodejs": "nodejs",
    "golang": "go",
    "k8s": "kubernetes",
    "llms": "llm",
    "restful": "rest",
    "rest api": "rest",
}

# Words that *look* like a technology but never are a claim - prose, roles, self-reference. Kept
# explicit so a false positive is a one-line list edit instead of a code change.
NOT_TECH = frozenset(
    {
        "cv", "cvs", "ats", "jd", "jds", "pdf", "docx", "url", "urls", "cto", "ceo", "cfo",
        "kpi", "kpis", "okr", "okrs", "mvp", "poc", "roi", "sla", "slo", "b2b", "b2c", "hr",
    }
)

# Technology-shaped names no vocabulary can enumerate: an internal capital (`FastAPI`, `FastMCP`,
# `PyTorch`, `PostgreSQL`, `JavaScript`) or a digit (`GPT-4`, `n8n`, `OAuth2`). Deliberately
# shape-only: a bare ALL-CAPS acronym is *not* read this way, because prose is full of them (CV,
# ATS, KPI) - that class stays in the curated vocabulary, where a false positive is a list edit.
SHAPE_PATTERN = re.compile(
    r"\b[A-Za-z]+(?:[A-Z][A-Za-z0-9]*)+\b"  # internal capital: FastAPI, FastMCP, PyTorch
    r"|\b[A-Za-z]{2,}\d[A-Za-z0-9.+]*\b"  # a digit inside the name: GPT-4, OAuth2, n8n
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


def tech_variants(name: str) -> set[str]:
    """Every spelling that names the same technology - the canonical one and its aliases."""
    lowered = (name or "").lower()
    canonical = TECH_ALIASES.get(lowered, lowered)
    spellings = {canonical, lowered}
    spellings.update(spelling for spelling, target in TECH_ALIASES.items() if target == canonical)
    return spellings


def mentions_technology(text: str, name: str) -> bool:
    """Whether `text` states `name`, in any of its spellings, singular or plural.

    Word-boundary matching over the normalised text, so `API` is not found inside `capital` and
    `.NET` *is* found inside `Using .NET 8`. A trailing `s` counts too: a CV that says "REST APIs"
    evidences a claim about "API".
    """
    haystack = _normalize_text(text or "")
    for spelling in tech_variants(name):
        for form in (spelling, f"{spelling}s"):
            if re.search(rf"(?<![\w]){re.escape(form)}(?![\w])", haystack):
                return True
    return False


def extract_tech_keywords(text: str) -> set[str]:
    """Every technology *claim* in `text`: the curated vocabulary plus the shape detector.

    Upper-cased, so a violation names the token the way the document shows it.

    An ALL-CAPS word with no digit is **not** a claim by shape: it is a name or a heading
    (`ARTEM`, `BLOGS`, `EDUCATION` - found live on 2026-10-02, when the gate rejected a real CV for
    its own name). Consecutive capitals satisfy the "internal capital" test, so that class is
    excluded here and read only through the vocabulary, where `MCP`, `RAG`, `LLM` and friends live
    with a one-line escape hatch when a false positive shows up.
    """
    claims = {name for name in TECH_VOCABULARY if mentions_technology(text, name)}
    for token in SHAPE_PATTERN.findall(text or ""):
        lowered = token.lower()
        if lowered in NOT_TECH:
            continue
        if token.isupper() and not any(character.isdigit() for character in token):
            continue
        claims.add(lowered)
    return {claim.upper() for claim in claims}


def invented_technologies(text: str, *evidence_texts: str) -> list[str]:
    """The technology claims in `text` that none of `evidence_texts` states.

    The single rule the whole pipeline runs on: the replacement check passes the master CV text and
    the candidate facts, the document gate passes the produced file. The job description is never
    passed here - it is the target, not evidence (invariants 7, 33).
    """
    return [
        claim
        for claim in sorted(extract_tech_keywords(text))
        if not any(mentions_technology(evidence, claim) for evidence in evidence_texts)
    ]


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
    norm_facts = _normalize_text(ground_truth)

    # 1. Numeric & Metric Verification: Every number in tailored text MUST exist in the source CV
    orig_numbers = extract_numbers(original_text)
    tailored_numbers = extract_numbers(tailored_text)

    for num in tailored_numbers:
        if num not in orig_numbers and num not in norm_cv and num not in norm_facts:
            violations.append(f"Invented or altered metric/number '{num}' in tailored text: '{tailored_text}'")

    # 2. Technology & Tool Claims: the CV text and the candidate facts are the ONLY admissible
    #    sources (invariants 7, 33). The job description is the *target* - a vacancy asking for a
    #    technology is not evidence the candidate has it, so a claim it names is dropped rather than
    #    surfaced. It is read here only to say *why* the claim was dropped.
    for tech in invented_technologies(tailored_text, cv_text, ground_truth):
        asked_by_vacancy = bool(job_description) and mentions_technology(job_description, tech)
        reason = (
            "; the vacancy asks for it, which is a reason to leave it out)"
            if asked_by_vacancy
            else ")"
        )
        violations.append(
            f"Unlisted technology claim '{tech}' found in tailored text "
            f"(absent from the CV text and the candidate facts{reason}"
        )

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


def scan_document_for_fabrications(
    document_text: str, cv_text: str, ground_truth: str = "", master_text: str = ""
) -> list[str]:
    """Check a *finished* document the way a replacement is checked - the last line of defence.

    `evaluate_fabrications` only ever sees what the model proposed. This reads what the file
    actually says, so a claim that reached the DOCX by any other route is caught as well. The
    `verify_document` node calls it and **fails the task** rather than upload a document with a
    claim nothing can back.

    `master_text` is the master document's own text and it matters: the produced file is that
    document plus the replacements, so anything the *master* already says (the name line, the
    `BLOGS` / `EDUCATION` headings, a company) is evidenced by definition. Passing only `cv_text`
    - the prompt's view of the CV model, which leaves those pieces out - flagged a real CV for its
    own name on 2026-10-02.
    """
    evidence = (cv_text, ground_truth, master_text)
    violations = [f"Unlisted technology claim '{tech}' in the produced document "
                  "(absent from the CV text and the candidate facts)"
                  for tech in invented_technologies(document_text, *evidence)]
    evidenced_numbers = extract_numbers(cv_text) | extract_numbers(master_text)
    facts = _normalize_text(ground_truth)
    for number in sorted(extract_numbers(document_text)):
        if number not in evidenced_numbers and number not in facts:
            violations.append(f"Invented or altered metric/number '{number}' in the produced document")
    return violations


def _as_replacements(modification_list) -> list:
    """The `(original, tailored, reason)` triples every caller of this module works with."""
    return [
        (item.original_text, item.tailored_text, getattr(item, "reason", "N/A"))
        for item in modification_list.modifications
    ]


def self_heal_replacements(
    suggest,
    prompt: str,
    cv_text: str,
    raw_replacements: list,
    *,
    job_description: str = "",
    ground_truth: str = "",
    max_retries: int = 0,
) -> tuple:
    """Grade one answer, then ask again while it still lies - up to `max_retries` times.

    `suggest(prompt)` is the model call, injected so this loop is testable without a client.
    Returns `(best_result, attempts)`: the best graded answer seen, and the retries it took.

    Only the *best* draft survives - a retry that grades worse than the draft already in hand is
    discarded, so the loop cannot leave the answer worse than it found it. When the retries run
    out with violations left, the caller's strict filter drops the offending replacements and the
    original CV text stays in place, so nothing unbacked reaches the document either way.
    """
    def grade(items):
        return evaluate_fabrications(
            cv_text, items, job_description=job_description, ground_truth=ground_truth
        )

    best = grade(raw_replacements)
    attempts = 0
    while best.violations and attempts < max(0, int(max_retries)):
        attempts += 1
        log.warning(
            "fabrication detected in the model's answer - self-healing retry",
            attempt=attempts,
            max_retries=max_retries,
            lie_percentage=best.lie_percentage,
            violations=best.violations[:5],
        )
        retry_prompt = prompt + (
            "\n\nCRITICAL DETERMINISTIC VERIFICATION DETECTED FABRICATIONS ('LIES') "
            "(Rule 4 violation):\n"
            + "\n".join(f"- {violation}" for violation in best.violations)
            + "\n\nThe job description is a TARGET, never evidence: a technology it asks for and the "
            "CV / CANDIDATE FACTS do not state must simply be left out. Remove every invented "
            "metric, altered number and unlisted technology. Fabrication count MUST be 0."
        )
        try:
            fresh = suggest(retry_prompt)
        except Exception as exc:  # noqa: BLE001 - a failed retry keeps the draft already in hand
            log.warning("self-healing retry failed", attempt=attempts, error=str(exc))
            break
        graded = grade(_as_replacements(fresh))
        if len(graded.violations) <= len(best.violations):
            best = graded
    return best, attempts
