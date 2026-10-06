"""What a proposed replacement must be - and what it may never touch.

Both rules are enforced here rather than trusted to the prompt:

* `normalize_replacements()` keeps one replacement to ONE clean line. The model returns a SKILLS
  label concatenated with its value (two paragraphs in the DOCX, so unmatchable), a leading
  bullet marker (Word renders its own, so a double bullet appears) or a no-op.
* `drop_read_only_replacements()` keeps the projects block out of the replacement set. Those
  paragraphs are *context* for the SUMMARY and RELEVANT SKILLS - a project stack is proof
  of a technology - and rewriting them costs the entry layout and the URLs.
"""

from utils.cv_text import (
    as_plain_dict,
    normalize_text,
    project_lines,
    split_lines,
    strip_leading_bullet,
)
from utils.logging_setup import get_logger

log = get_logger(__name__)

# A replacement target shorter than this cannot be a project line; testing a fragment that short
# against the projects block would only produce false drops.
READ_ONLY_FRAGMENT_MIN_CHARS = 20


def normalize_replacements(items):
    """
    Sanitise suggested replacements so no single replacement ever spans more than
    one paragraph/line of the DOCX.

    The tailoring model sometimes concatenates a SKILLS category label with its
    value (e.g. "Leadership & Methodology\\nSystem Architecture, ..."). Because a
    label and its value live in SEPARATE paragraphs in the DOCX, such a
    concatenated original_text can never be matched. This function splits any
    multi-line replacement into one clean, single-line (original, tailored,
    reason) entry per aligned line, drops entries whose line counts do not match,
    strips leading bullet markers (which Word would render as a double bullet) and
    drops no-op entries (original == tailored).

    Items may be (original, tailored) or (original, tailored, reason) tuples.
    """
    normalized = []
    for item in items:
        if len(item) == 3:
            original_text, tailored_text, reason = item
        else:
            original_text, tailored_text = item[:2]
            reason = "N/A"

        original_text = strip_leading_bullet(original_text.strip())
        tailored_text = strip_leading_bullet(tailored_text.strip())

        original_lines = split_lines(original_text)
        tailored_lines = split_lines(tailored_text)

        # Multi-line (concatenated label + value) replacement: split into pairs.
        if len(original_lines) > 1 or len(tailored_lines) > 1:
            if len(original_lines) != len(tailored_lines):
                log.warning(
                    "dropping replacement that spans multiple lines and cannot be aligned",
                    original=original_text,
                    tailored=tailored_text,
                )
                continue
            for original_line, tailored_line in zip(
                original_lines, tailored_lines, strict=True
            ):
                if original_line and tailored_line and original_line != tailored_line:
                    normalized.append((original_line, tailored_line, reason))
            continue

        # Normal single-line replacement.
        original_line = original_lines[0] if original_lines else original_text
        tailored_line = tailored_lines[0] if tailored_lines else tailored_text
        if original_line and tailored_line and original_line != tailored_line:
            normalized.append((original_line, tailored_line, reason))

    return normalized


def read_only_lines(cv_data):
    """The rendered lines of the read-only context block (the document's PET PROJECTS block)."""
    cv_data = as_plain_dict(cv_data)
    if not cv_data:
        return []
    lines: list[str] = []
    for project in cv_data.get("personal_projects") or []:
        lines.extend(project_lines(project))
    return lines


def drop_read_only_replacements(replacements, cv_data):
    """Drop any replacement that targets the read-only projects block (PET PROJECTS).

    Projects are *context*: they tell the model which technologies the candidate really has so
    the SUMMARY and RELEVANT SKILLS rewrites can draw on them (a project stack is proof, not a
    claim). The project paragraphs themselves are never rewritten - the title/year row carries
    the entry layout and the Website/Repo/YT Video lines carry the URLs, so a rewrite there
    costs layout and links for nothing. The prompt states the rule; this is what enforces it.

    A target matches when it *is* a project line, or when it is a fragment of one (at least
    `READ_ONLY_FRAGMENT_MIN_CHARS` long - a shorter fragment such as "Stack" would only produce
    false drops). Items are `(original, tailored[, reason])`, like `normalize_replacements()`.
    """
    exact = {normalize_text(line) for line in read_only_lines(cv_data)}
    if not exact:
        return list(replacements)
    block = "\n".join(exact)

    kept = []
    for item in replacements:
        original = item[0] if item else ""
        target = normalize_text(strip_leading_bullet(str(original).strip()))
        if target and (
            target in exact
            or (len(target) >= READ_ONLY_FRAGMENT_MIN_CHARS and target in block)
        ):
            log.warning(
                "dropped a replacement targeting the read-only projects block",
                original=original,
            )
            continue
        kept.append(item)
    return kept
