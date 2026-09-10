import os
import json
import docx

# utils/docx_mutator.py lives one level below the repo root.
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Static CV data model (header / summary / skills / professional_experience).
CV_DATA_JSON = os.path.join(BASE_DIR, "artifacts", "cv_data.json")


def _load_cv_data(path=CV_DATA_JSON):
    """Load the static CV data model from the artifacts JSON file."""
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _clean_char(c: str) -> str:
    if c == '\xa0':
        return ' '
    if c in ('\u2013', '\u2014'):
        return '-'
    return c

def _norm_str(s: str) -> str:
    return "".join(_clean_char(c) for c in s)


def _strip_leading_bullet(s: str) -> str:
    """Remove a leading bullet/list marker so Word does not render a double bullet."""
    for prefix in ("• ", "- ", "* ", "o ", "– ", "— ", "•", "-", "*", "–", "—"):
        if s.startswith(prefix):
            return s[len(prefix):].strip()
    return s


def _split_lines(text):
    """Split a string into its non-empty, whitespace-stripped single lines."""
    return [ln.strip() for ln in text.replace("\r\n", "\n").replace("\r", "\n").split("\n") if ln.strip()]


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
                print("  ⚠️  Dropping replacement that spans multiple lines and cannot be aligned:")
                print(f"      Original: {original_text!r}")
                print(f"      Tailored: {tailored_text!r}")
                continue
            for o_line, t_line in zip(original_lines, tailored_lines):
                if o_line and t_line and o_line != t_line:
                    normalized.append((o_line, t_line, reason))
            continue

        # Normal single-line replacement.
        o_line = original_lines[0] if original_lines else original_text
        t_line = tailored_lines[0] if tailored_lines else tailored_text
        if o_line and t_line and o_line != t_line:
            normalized.append((o_line, t_line, reason))

    return normalized


def iter_all_paragraphs(container, seen=None):
    if seen is None:
        seen = set()
    for p in getattr(container, 'paragraphs', []):
        if p._element not in seen:
            seen.add(p._element)
            yield p
    for table in getattr(container, 'tables', []):
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
        r_start = norm_run.find(norm_target)
        if r_start != -1:
            r_end = r_start + len(norm_target)
            run.text = run.text[:r_start] + tailored_text + run.text[r_end:]
            return True

    combined_text = "".join(r.text for r in runs)
    norm_combined = _norm_str(combined_text)
    
    match_start = norm_combined.find(norm_target)
    if match_start == -1:
        paragraph.text = full_text[:match_start] + tailored_text + full_text[match_end:]
        return True
        
    match_end = match_start + len(norm_target)

    run_ranges = []
    curr_len = 0
    for idx, run in enumerate(runs):
        start = curr_len
        curr_len += len(run.text)
        end = curr_len
        run_ranges.append((idx, start, end))

    affected_runs = []
    for idx, start, end in run_ranges:
        if max(start, match_start) < min(end, match_end):
            affected_runs.append(idx)

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

    for idx in affected_runs[1:]:
        if idx == last_idx and first_idx != last_idx:
            runs[idx].text = suffix
        else:
            runs[idx].text = ""

    return True

def apply_text_replacements(doc_path, replacements, output_path):
    doc = docx.Document(doc_path)
    count = 0
    all_paragraphs = list(iter_all_paragraphs(doc))

    print(f"\n📝 [Step: apply_text_replacements] Processing {len(replacements)} suggested text block replacement(s)...")
    for idx, item in enumerate(replacements, 1):
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
            print(f"\n  [Replacement #{idx}/{len(replacements)}] ⚠️  Skipped — original_text spans multiple lines and can never match a single paragraph:")
            print(f"    • Original:    {original_text}")
            print(f"    • Reason:      {reason}")
            continue

        applied = False
        for p in all_paragraphs:
            if _replace_text_in_paragraph(p, original_text, tailored_text):
                count += 1
                applied = True
                print(f"\n  [Replacement #{idx}/{len(replacements)}] ✅ Applied to DOCX:")
                print(f"    • Original:    {original_text}")
                print(f"    • Replacement: {tailored_text}")
                print(f"    • Reason:      {reason}")
                break
        if not applied:
            print(f"\n  [Replacement #{idx}/{len(replacements)}] ⚠️  Could NOT find matching target text in DOCX:")
            print(f"    • Original:    {original_text}")
            print(f"    • Reason:      {reason}")

    doc.save(output_path)
    return count

def extract_doc_text(doc_path=None):
    return get_encoded_cv_text()

STATIC_CV_DATA = _load_cv_data(CV_DATA_JSON)

def get_encoded_cv_text():
    lines = [
        STATIC_CV_DATA['header']['title'],
        "\nSUMMARY:",
        STATIC_CV_DATA['summary'],
        "\nRELEVANT SKILLS:"
    ]
    for category, skills in STATIC_CV_DATA['skills'].items():
        lines.append(category)
        lines.append(skills)
        
    lines.append("\nPROFESSIONAL EXPERIENCE:")
    for exp in STATIC_CV_DATA['professional_experience']:
        lines.append(f"\n{exp['role']}")
        lines.append(f"{exp['company_info']}")
        for h in exp['highlights']:
            lines.append(f"• {h}")
        
    return "\n".join(lines)
