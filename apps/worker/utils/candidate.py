"""The candidate facts every prompt is grounded in.

`cv_data.json` is the CV's *content* (summary, skills, experience) and carries **no contacts at
all** - which is exactly why this is a second document rather than a section of that one. It holds
who the candidate is, how to reach them, and the standing facts a recruiter or a form asks for:
salary expectation, availability, work rights, English level, the projects worth talking about,
and the answers the candidate is happy to repeat ("notice period", "how did you ensure
reliability", ...).

Three prompts read this block - the CV tailoring prompt, the cover letter and the form prompt - so
it is the *one* place a fact about the candidate is maintained. It is ground-truth **evidence**
about experience (it may justify a technology or a number the CV text does not spell out), never
document text: the CV keeps no contacts, salary, availability, work format or job-search status.

It lives in the database (`application_profile`, one jsonb document per operator) rather than a file
on the artifact volume, and that is deliberate: the board edits it on the host with the operator's
own token while the workers read it in the cluster - two different filesystems, one shared
Postgres. Everything here is **pure**: the store reads the row, this module decides what the prompt
may see, and a missing row is not an error (the prompt then says the candidate block is empty and
the model skips what it cannot answer instead of inventing it).

`scripts/seed_profile.py` writes a JSON file into that row, which is how a longer answer set is
loaded without a UI.
"""

import json

from utils.logging_setup import get_logger

log = get_logger(__name__)

# The facts, in the order the prompt lists them. `label` is what the model sees, so a new fact is
# one row here (plus the mirrored list in `apps/backoffice/src/lib/candidate.ts`).
FACTS: tuple[tuple[str, str], ...] = (
    ("full_name", "NAME"),
    ("email", "EMAIL"),
    ("phone", "PHONE"),
    ("location", "LOCATION"),
    ("linkedin", "LINKEDIN"),
    ("github", "GITHUB"),
    ("portfolio", "PORTFOLIO"),
    ("english_level", "ENGLISH LEVEL"),
    ("salary_expectation", "SALARY EXPECTATION"),
    ("availability", "AVAILABILITY / NOTICE PERIOD"),
    ("work_rights", "WORK RIGHTS"),
)

# Caps: this is data a human types, and the prompt must not be inflatable from a form-less place.
# A *fact* is a form-field value (short); a *standing answer* is prose - a project deep-dive or a
# "how did you ensure reliability" story - so it carries its own, longer cap.
MAX_VALUE_CHARS = 600
MAX_ANSWER_CHARS = 3000
MAX_ANSWERS = 40


def sanitize(raw) -> dict:
    """Keep the known fact keys, drop everything else, cap the lengths.

    Returning a *small* dict rather than the row's content is the point: an unknown key would be
    silently dropped from the prompt, and an unbounded one would push the form out of the window.
    A jsonb row comes back as a dict; a JSON string (the file backend) is decoded first.
    """
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return {}
    if not isinstance(raw, dict):
        return {}
    profile: dict[str, str] = {}
    for key, _label in FACTS:
        value = raw.get(key)
        if isinstance(value, (str, int, float)) and str(value).strip():
            profile[key] = str(value).strip()[:MAX_VALUE_CHARS]

    answers = raw.get("standing_answers")
    if isinstance(answers, dict):
        kept: dict[str, str] = {}
        for question, answer in list(answers.items())[:MAX_ANSWERS]:
            if not isinstance(question, str) or not question.strip():
                continue
            if isinstance(answer, (str, int, float)) and str(answer).strip():
                key = question.strip()[:MAX_VALUE_CHARS]
                kept[key] = str(answer).strip()[:MAX_ANSWER_CHARS]
        if kept:
            profile["standing_answers"] = kept
    return profile


def load(store, user_id) -> dict:
    """The candidate facts of one operator, or `{}` when there is no row (never an error)."""
    if not user_id:
        log.info("this card has no owner - the prompt will have an empty candidate block")
        return {}
    try:
        row = store.get_application_profile(user_id)
    except Exception as exc:  # noqa: BLE001 - a missing profile must not fail a draft
        log.warning("could not read the candidate facts", user_id=user_id, error=str(exc))
        return {}
    facts = sanitize((row or {}).get("facts")) if row else {}
    if not facts:
        log.info("no candidate facts stored - the model will skip what it cannot answer",
                 user_id=user_id)
    return facts


def full_name(store, user_id) -> str:
    """The candidate's own name - the one fact an *artifact name* is built from.

    Pure like everything here: the store is handed in. This is what makes a download read
    `artemmuntianu-852417.pdf` instead of `852417.pdf` (`utils/storage.artifact_stem` squeezes it into
    a slug), and `load()` already answers `{}` for a missing row or an unreachable store, so no name
    is `''` rather than an error - the artifact then keeps the vacancy id.
    """
    return str(load(store, user_id).get("full_name") or "").strip()


def digest(candidate) -> str:
    """The candidate block of every prompt: one labelled line per fact, the standing answers last.

    Three callers (`apps/worker/agent/application.py`, `apps/worker/agent/cover.py`, `agent.nodes.adapt_text`) read the
    same renderer, so a fact is maintained once. What the *document* prompts must never copy
    verbatim - contacts, salary, availability, work format, job-search status - is stated by their
    own CV-safety rules, not here.
    """
    profile = sanitize(candidate) if not isinstance(candidate, dict) else candidate
    lines = [f"{label}: {profile[key]}" for key, label in FACTS if profile.get(key)]
    answers = profile.get("standing_answers") or {}
    for question, answer in answers.items():
        lines.append(f"STANDING ANSWER - {question}: {answer}")
    return "\n".join(lines)
