"""The candidate facts an application form is filled from.

`cv_data.json` is the CV's *content* (summary, skills, experience) and carries **no contacts at
all** - which is exactly why this is a second document rather than a section of that one. It holds
who the candidate is, how to reach them, and the standing facts a form asks for: salary
expectation, availability, work rights, English level, and the answers the candidate is happy to
repeat ("notice period", "relocation", ...).

It lives in the database (`application_profile`, one jsonb document per operator) rather than a file
on the artifact volume, and that is deliberate: the board edits it on the host with the operator's
own token while the `apply` worker reads it in the cluster - two different filesystems, one shared
Postgres. Everything here is **pure**: the store reads the row, this module decides what the prompt
may see, and a missing row is not an error (the prompt then says the candidate block is empty and
the model skips what it cannot answer instead of inventing it).
"""

import json

from utils.logging_setup import get_logger

log = get_logger(__name__)

# The facts, in the order the prompt lists them. `label` is what the model sees, so a new fact is
# one row here (plus a line in the extension's profile editor).
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
MAX_VALUE_CHARS = 600
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
                kept[question.strip()[:MAX_VALUE_CHARS]] = str(answer).strip()[:MAX_VALUE_CHARS]
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


def digest(candidate) -> str:
    """The candidate block of the prompt: one labelled line per fact, then the standing answers."""
    profile = sanitize(candidate) if not isinstance(candidate, dict) else candidate
    lines = [f"{label}: {profile[key]}" for key, label in FACTS if profile.get(key)]
    answers = profile.get("standing_answers") or {}
    for question, answer in answers.items():
        lines.append(f"STANDING ANSWER - {question}: {answer}")
    return "\n".join(lines)
