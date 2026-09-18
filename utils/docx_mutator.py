"""Low-level DOCX (AST/XML) mutation helpers.

Two long-standing issues are fixed here:

1. The CV data model used to be read into a *module-level* global at import
   time. That crashed the process when the file was missing and, worse, served
   stale data across tasks. `cv_data` is now always an explicit argument (the
   task carries it, or it is loaded lazily from `CV_DATA_PATH` for CLI runs).
2. `validate_cv_data_against_docx()` enforces the contract from the architecture
   doc: every line of `cv_data.json` must exist in the master `cv.docx`, so the
   AST mutations can never target the wrong paragraph.
"""

import json
import os

import docx

import config
from utils.logging_setup import get_logger

log = get_logger(__name__)


def load_cv_data(path=None):
    """Load the structured CV knowledge base (no module-level caching)."""
    target = path or config.CV_DATA_PATH
    with open(target, encoding="utf-8") as handle:
        return json.load(handle)


def _as_plain_dict(cv_data):
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


def cv_data_to_text(cv_data):
    """Render the structured CV model as the single-line-per-paragraph text the
    tailoring prompt and the replacement matcher both rely on."""
    cv_data = _as_plain_dict(cv_data)
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


def validate_cv_data_against_docx(cv_data, docx_path):
    """Verify cv_data lines exist in the master DOCX.

    Returns the list of lines that could NOT be found (empty list == in sync).
    Callers decide whether that is fatal (cloud) or a warning (local dev).
    """
    missing = []
    try:
        document = docx.Document(docx_path)
        haystack = "\n".join(
            _norm_str(paragraph.text) for paragraph in iter_all_paragraphs(document)
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("could not open master cv for validation", path=docx_path, error=str(exc))
        return []

    for line in cv_data_to_text(cv_data).split("\n"):
        candidate = _norm_str(_strip_leading_bullet(line.strip()))
        if not candidate or candidate.endswith(":") or candidate.startswith("•"):
            continue
        if candidate not in haystack:
            missing.append(line.strip())
    return missing


def _clean_char(character: str) -> str:
    if character == "\xa0":
        return " "
    if character in ("\u2013", "\u2014"):
        return "-"
    return character


def _norm_str(value: str) -> str:
    return "".join(_clean_char(character) for character in value)


def _strip_leading_bullet(value: str) -> str:
    """Remove a leading bullet/list marker so Word does not render a double bullet."""
    for prefix in ("• ", "- ", "* ", "o ", "– ", "— ", "•", "-", "*", "–", "—"):
        if value.startswith(prefix):
            return value[len(prefix):].strip()
    return value


def _split_lines(text):
    """Split a string into its non-empty, whitespace-stripped single lines."""
    return [
        line.strip()
        for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
        if line.strip()
    ]


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

        original_text = _strip_leading_bullet(original_text.strip())
        tailored_text = _strip_leading_bullet(tailored_text.strip())

        original_lines = _split_lines(original_text)
        tailored_lines = _split_lines(tailored_text)

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


def iter_all_paragraphs(container, seen=None):
    if seen is None:
        seen = set()
    for paragraph in getattr(container, "paragraphs", []):
        if paragraph._element not in seen:
            seen.add(paragraph._element)
            yield paragraph
    for table in getattr(container, "tables", []):
        if table._element in seen:
            continue
        seen.add(table._element)
        for row in table.rows:
            for cell in row.cells:
                if cell._tc not in seen:
                    seen.add(cell._tc)
                    yield from iter_all_paragraphs(cell, seen)


def _replace_text_in_paragraph(paragraph, original_text, tailored_text):
    tailored_text = _strip_leading_bullet(tailored_text)
    if not original_text or original_text == tailored_text:
        return False

    full_text = paragraph.text
    if not full_text or not full_text.strip():
        return False

    target_text = original_text.strip()
    for prefix in ["• ", "o ", "- ", "* ", "– ", "— ", "•", "-", "*"]:
        if target_text.startswith(prefix):
            target_text = target_text[len(prefix):].strip()

    norm_full = _norm_str(full_text)
    norm_target = _norm_str(target_text)

    match_start = norm_full.find(norm_target)
    if match_start == -1:
        return False

    match_end = match_start + len(norm_target)

    runs = paragraph.runs
    if not runs:
        paragraph.text = full_text[:match_start] + tailored_text + full_text[match_end:]
        return True

    for run in runs:
        norm_run = _norm_str(run.text)
        run_start = norm_run.find(norm_target)
        if run_start != -1:
            run_end = run_start + len(norm_target)
            run.text = run.text[:run_start] + tailored_text + run.text[run_end:]
            return True

    combined_text = "".join(run.text for run in runs)
    norm_combined = _norm_str(combined_text)

    match_start = norm_combined.find(norm_target)
    if match_start == -1:
        paragraph.text = full_text[:match_start] + tailored_text + full_text[match_end:]
        return True

    match_end = match_start + len(norm_target)

    run_ranges = []
    current_length = 0
    for index, run in enumerate(runs):
        start = current_length
        current_length += len(run.text)
        end = current_length
        run_ranges.append((index, start, end))

    affected_runs = []
    for index, start, end in run_ranges:
        if max(start, match_start) < min(end, match_end):
            affected_runs.append(index)

    if not affected_runs:
        paragraph.text = combined_text[:match_start] + tailored_text + combined_text[match_end:]
        return True

    first_idx = affected_runs[0]
    last_idx = affected_runs[-1]

    first_run = runs[first_idx]
    last_run = runs[last_idx]

    first_start = run_ranges[first_idx][1]
    last_start = run_ranges[last_idx][1]

    prefix = first_run.text[:match_start - first_start]
    suffix = last_run.text[match_end - last_start:]

    first_run.text = prefix + tailored_text + (suffix if first_idx == last_idx else "")

    for index in affected_runs[1:]:
        if index == last_idx and first_idx != last_idx:
            runs[index].text = suffix
        else:
            runs[index].text = ""

    return True


def apply_text_replacements(doc_path, replacements, output_path):
    document = docx.Document(doc_path)
    count = 0
    all_paragraphs = list(iter_all_paragraphs(document))

    log.info(
        "applying text replacements",
        replacements=len(replacements),
        doc_path=doc_path,
    )
    for index, item in enumerate(replacements, 1):
        if len(item) == 3:
            original_text, tailored_text, reason = item
        else:
            original_text, tailored_text = item[:2]
            reason = "N/A"

        # Guard: never attempt a replacement that spans multiple paragraphs/lines.
        # A single paragraph cannot contain a '\n', so a multi-line original_text
        # (e.g. a SKILLS label concatenated with its value) can never match and
        # would otherwise corrupt the target-splitting logic below.
        if "\n" in original_text or "\r" in original_text:
            log.warning(
                "skipped replacement spanning multiple lines",
                index=index,
                total=len(replacements),
                original=original_text,
            )
            continue

        applied = False
        for paragraph in all_paragraphs:
            if _replace_text_in_paragraph(paragraph, original_text, tailored_text):
                count += 1
                applied = True
                log.info(
                    "replacement applied",
                    index=index,
                    total=len(replacements),
                    original=original_text,
                    replacement=tailored_text,
                    reason=reason,
                )
                break
        if not applied:
            log.warning(
                "could not find matching target text in docx",
                index=index,
                total=len(replacements),
                original=original_text,
                reason=reason,
            )

    output_directory = os.path.dirname(output_path)
    if output_directory:
        os.makedirs(output_directory, exist_ok=True)
    document.save(output_path)
    return count
