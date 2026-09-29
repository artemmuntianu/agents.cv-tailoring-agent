"""`cv_data.json` as text - the master CV in the shape every prompt and matcher needs.

`load_cv_data()` is deliberately *not* cached at module level: a module-level copy once served a
later task stale data, which is why `cv_data` is an explicit argument everywhere downstream.
`cv_data_to_text()` renders the model into the single-line-per-paragraph dump the tailoring
prompt receives - and every replacement target is matched against - while the normalisers below
are the comparison form shared with `utils.docx_mutator` and `utils.cv_replacements`.

The PERSONAL PROJECTS block is part of that dump: the model has to see it to draw on it, and
`utils.cv_replacements.drop_read_only_replacements()` is what keeps it out of the replacement set.
"""

import json
import os

import config


def load_cv_data(path=None):
    """Load the structured CV knowledge base (no module-level caching)."""
    target = path or config.CV_DATA_PATH
    with open(target, encoding="utf-8") as handle:
        return json.load(handle)


def as_plain_dict(cv_data):
    """Accept a pydantic model, a dict, or a JSON string and return a dict.

    The queue payload is validated into `agent.contracts.CvData`, while the CLI
    loads raw JSON - both must reach the mutator as plain mappings.
    """
    if cv_data is None:
        return None
    if hasattr(cv_data, "model_dump"):
        return cv_data.model_dump()
    if isinstance(cv_data, (str, bytes)):
        return json.loads(cv_data)
    return cv_data


def _clean_char(character: str) -> str:
    if character == "\xa0":
        return " "
    if character in ("\u2013", "\u2014"):
        return "-"
    return character


def normalize_text(value: str) -> str:
    return "".join(_clean_char(character) for character in value)


def strip_leading_bullet(value: str) -> str:
    """Remove a leading bullet/list marker so Word does not render a double bullet."""
    for prefix in ("• ", "- ", "* ", "o ", "– ", "— ", "•", "-", "*", "–", "—"):
        if value.startswith(prefix):
            return value[len(prefix):].strip()
    return value


def split_lines(text):
    """Split a string into its non-empty, whitespace-stripped single lines."""
    return [
        line.strip()
        for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
        if line.strip()
    ]


def project_lines(project):
    """One project as the single-line-per-paragraph text the master DOCX carries.

    The order mirrors the document: heading (verbatim - it holds the right-aligned tab run and
    the year), description, the `Highlights:` label, the bullets, the link lines, the stack.
    """
    lines = [project["heading"]]
    if project.get("description"):
        lines.append(project["description"])
    highlights = project.get("highlights") or []
    if highlights:
        lines.append("Highlights:")
        lines.extend(f"• {highlight}" for highlight in highlights)
    lines.extend(project.get("links") or [])
    if project.get("stack"):
        lines.append(f"Stack: {project['stack']}")
    return lines


def cv_data_to_text(cv_data):
    """Render the structured CV model as the single-line-per-paragraph text the
    tailoring prompt and the replacement matcher both rely on.

    The PERSONAL PROJECTS block is rendered too - the model has to see it to draw on it - but
    it is *read-only context*: `drop_read_only_replacements()` is what keeps a replacement from
    targeting its lines.
    """
    cv_data = as_plain_dict(cv_data)
    if not cv_data:
        raise ValueError("cv_data is required to build the CV text")

    lines = [
        cv_data["header"]["title"],
        "\nSUMMARY:",
        cv_data["summary"],
        "\nRELEVANT SKILLS:",
    ]
    for category, skills in cv_data["skills"].items():
        lines.append(category)
        lines.append(skills)

    lines.append("\nPROFESSIONAL EXPERIENCE:")
    for experience in cv_data["professional_experience"]:
        lines.append(f"\n{experience['role']}")
        lines.append(f"{experience['company_info']}")
        for highlight in experience["highlights"]:
            lines.append(f"• {highlight}")

    projects = cv_data.get("personal_projects") or []
    if projects:
        lines.append("\nPERSONAL PROJECTS:")
        for project in projects:
            lines.extend(project_lines(project))

    return "\n".join(lines)


def get_encoded_cv_text(cv_data=None):
    """Backwards-compatible accessor used by the CLI path."""
    return cv_data_to_text(cv_data if cv_data is not None else load_cv_data())


def extract_doc_text(cv_data=None, doc_path=None):
    """Return the prompt-ready CV text.

    Accepts either the new `(cv_data)` / `(cv_data=..., doc_path=...)` form or a
    bare path string for backwards compatibility.
    """
    if isinstance(cv_data, (str, os.PathLike)) and doc_path is None:
        doc_path = cv_data
        cv_data = None
    if cv_data is None:
        cv_data = load_cv_data()
    return cv_data_to_text(cv_data)
