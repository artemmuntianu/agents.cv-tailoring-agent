"""Cover-letter generation - the one Gemini call the board triggers by hand.

`apps/worker/agent/tailoring_prompt.py` + `apps/worker/agent/nodes.py` own the tailoring prompt; this module owns the
letter prompt. Both go
through `utils.retry.retry_with_exponential_backoff` (invariant 12) and both ask for a
Pydantic `response_schema`, so nothing here parses free text.

The letter is written from what the system already knows: the vacancy's stored description
(`resumes.description_raw`), the master CV model (`cv_data.json`, the same file the
tailoring prompt is built from) and the operator's candidate facts (the `application_profile`
row, the same document the form prompt is built from). The payload never carries its own copy
of any of them, so a stale copy cannot reach the prompt - and the prompt forbids inventing
anything the CV does not say (invariant 7 applies to the letter too).
"""

from google.genai import types
from pydantic import BaseModel, Field

import config
from agent import gemini
from utils import candidate as candidate_module
from utils.logging_setup import get_logger
from utils.retry import retry_with_exponential_backoff

log = get_logger(__name__)

COVER_LETTER_PROMPT = """\
You write one cover letter for one specific vacancy, in English.

The rules below are the contract, not style advice:
- Use ONLY facts that appear in the CV block, the CANDIDATE FACTS block or the vacancy text.
  Never invent an employer, a title, a date, a technology, a metric or a certification.
- Plain text only: no markdown, no headings, no bullet characters, no placeholders such as
  [Company]. Three short paragraphs, under 160 words in total, **separated by a blank line**
  (`\n\n`) - a single run-on block of text is not a letter.
- First paragraph: name the role and the company and say why this candidate fits, quoting the
  most relevant thing the CV already says.
- Second paragraph: map two or three concrete CV achievements onto what the vacancy asks for,
  keeping every number exactly as the CV states it.
- Third paragraph: state the language level and the ownership style **only if the CV block or
  the CANDIDATE FACTS block states them**; if neither does, write one sentence about how you
  work, taken from the CV's summary, instead of describing them in general terms.
- What a letter must never say, even when the CANDIDATE FACTS block knows it: a salary
  expectation, an availability or notice period, a work-format preference, a location, a
  contact detail, the fact that the candidate is job-hunting, or any other company's or
  recruiter's name. CANDIDATE FACTS is evidence about experience, not letter material.
- Close with "Best regards," and, **if and only if** the CV block has a NAME line, that name
  exactly as it is written there. Never sign with a job title, and never invent a name: if the
  CV has no NAME line, "Best regards," ends the letter.
- Never write a vague claim such as "standard language level" or "full ownership style": if the
  CV does not state a fact, leave it out rather than approximating it.
- Start with "Hello,".
- Answer with JSON matching the schema: a single "cover_letter" string.
"""


class CoverLetter(BaseModel):
    """The only response shape: the letter itself, as plain text."""

    cover_letter: str = Field(description="The letter, plain text, no markdown.")


def _as_dict(cv_data) -> dict:
    """Accept the JSON dict or the `CvData` model - the callers differ."""
    if cv_data is None:
        return {}
    if hasattr(cv_data, "model_dump"):
        return cv_data.model_dump()
    return cv_data if isinstance(cv_data, dict) else {}


def cv_digest(cv_data) -> str:
    """The CV facts the letter may use, in the order the CV itself states them.

    PET PROJECTS is deliberately left out: it is tailoring context (see
    `utils.cv_replacements.drop_read_only_replacements`), not letter material.
    """
    cv = _as_dict(cv_data)
    header = cv.get("header") or {}
    lines: list[str] = []
    # Both header fields are optional in practice: the master CV in this repo has a title and
    # *no* name, which is exactly why the prompt may not ask for a signature it cannot get.
    if header.get("name"):
        lines.append(f"NAME: {header['name']}")
    if header.get("title"):
        lines.append(f"HEADLINE: {header['title']}")
    if cv.get("summary"):
        lines.append(f"SUMMARY: {cv['summary']}")

    skills = cv.get("skills") or {}
    if skills:
        lines.append("SKILLS: " + "; ".join(f"{key}: {value}" for key, value in skills.items()))

    for experience in cv.get("professional_experience") or []:
        role = experience.get("role") or ""
        company = experience.get("company_info") or ""
        # The document splits one entry into four paragraphs; the letter's digest folds the
        # context and the period back onto the heading line, so a 160-word letter can place the
        # role in time without spending a line of its own on it.
        period = " ".join(
            part for part in (experience.get("context"), experience.get("dates")) if part
        )
        heading = f"EXPERIENCE: {role} - {company}".rstrip(" -")
        lines.append(f"{heading} ({period})" if period else heading)
        # Four highlights is plenty for a 160-word letter; more only invites padding.
        for highlight in (experience.get("highlights") or [])[:4]:
            lines.append(f"  - {highlight}")
    return "\n".join(lines)


def build_prompt(description_raw, cv_data=None, title="", company="", candidate=None) -> str:
    """Assemble the prompt. Pure, so the exact wording is unit tested."""
    vacancy = "\n".join(
        line for line in [f"TITLE: {title}".strip(), f"COMPANY: {company}".strip()] if line
    )
    return "\n".join(
        [
            COVER_LETTER_PROMPT,
            "-------------------- VACANCY --------------------",
            vacancy,
            (description_raw or "").strip(),
            "-------------------- CANDIDATE FACTS --------------------",
            candidate_module.digest(candidate) or "(no candidate facts stored)",
            "-------------------- CV --------------------",
            cv_digest(cv_data) or "(no CV model available)",
        ]
    ).strip()


@retry_with_exponential_backoff
def _call_gemini_cover_letter(client, prompt: str) -> CoverLetter:
    response = client.models.generate_content(
        model=config.MODEL_NAME,
        contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=CoverLetter,
            # Warmer than the tailoring calls: a letter is prose, and the facts are pinned
            # by the prompt rather than by temperature.
            temperature=0.4,
        ),
    )
    return CoverLetter.model_validate_json(response.text)


def run_cover_letter(
    job_id, description_raw, cv_data=None, title="", company="", candidate=None
) -> str:
    """Generate one cover letter.

    Raises `ValueError` when there is nothing to write from (the board refuses such a request
    before it is queued, so this is a broken-row guard), and `RetryLater` when the Gemini quota
    is out - the caller turns that into a delayed redelivery.
    """
    if not (description_raw or "").strip():
        raise ValueError("this vacancy has no stored job description")

    prompt = build_prompt(description_raw, cv_data, title, company, candidate)
    client = gemini.client()
    log.info("requesting a cover letter", job_id=job_id, model=config.MODEL_NAME)
    letter = _call_gemini_cover_letter(client, prompt).cover_letter.strip()
    if not letter:
        raise ValueError("the model returned an empty cover letter")
    return letter
