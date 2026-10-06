"""The mechanical half of the document surgery: walk the DOCX, match a line, write it back.

Nothing here decides *whether* a replacement is allowed. That is `utils.cv_replacements` (one
clean line, never a read-only projects line) plus `validate_cv_data_against_docx()` below, which
proves the model describes the document it is about to be applied to.

Tables are the trap: the master CV is built almost entirely out of them - a profile table, and a
two-column table that holds every role and project as a `content | meta` row pair - so
`iter_all_paragraphs()` recurses into cells (nested tables included) and `python-docx`'s own
`document.paragraphs` is never enough on its own (it saw a single paragraph of the whole CV).
"""

import os

import docx

from utils.cv_text import cv_data_to_text, normalize_text, strip_leading_bullet
from utils.logging_setup import get_logger

log = get_logger(__name__)


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


def validate_cv_data_against_docx(cv_data, docx_path):
    """Verify cv_data lines exist in the master DOCX.

    Returns the list of lines that could NOT be found (empty list == in sync).
    Callers decide whether that is fatal (cloud) or a warning (local dev).
    """
    missing = []
    try:
        document = docx.Document(docx_path)
        haystack = "\n".join(
            normalize_text(paragraph.text) for paragraph in iter_all_paragraphs(document)
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("could not open master cv for validation", path=docx_path, error=str(exc))
        return []

    for line in cv_data_to_text(cv_data).split("\n"):
        candidate = normalize_text(strip_leading_bullet(line.strip()))
        if not candidate or candidate.endswith(":") or candidate.startswith("•"):
            continue
        if candidate not in haystack:
            missing.append(line.strip())
    return missing


def _replace_text_in_paragraph(paragraph, original_text, tailored_text):
    tailored_text = strip_leading_bullet(tailored_text)
    if not original_text or original_text == tailored_text:
        return False

    full_text = paragraph.text
    if not full_text or not full_text.strip():
        return False

    target_text = original_text.strip()
    for prefix in ["• ", "o ", "- ", "* ", "– ", "— ", "•", "-", "*"]:
        if target_text.startswith(prefix):
            target_text = target_text[len(prefix):].strip()

    norm_full = normalize_text(full_text)
    norm_target = normalize_text(target_text)

    match_start = norm_full.find(norm_target)
    if match_start == -1:
        return False

    match_end = match_start + len(norm_target)

    runs = paragraph.runs
    if not runs:
        paragraph.text = full_text[:match_start] + tailored_text + full_text[match_end:]
        return True

    for run in runs:
        norm_run = normalize_text(run.text)
        run_start = norm_run.find(norm_target)
        if run_start != -1:
            run_end = run_start + len(norm_target)
            run.text = run.text[:run_start] + tailored_text + run.text[run_end:]
            return True

    combined_text = "".join(run.text for run in runs)
    norm_combined = normalize_text(combined_text)

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
