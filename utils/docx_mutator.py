import docx

def _replace_text_in_paragraph(paragraph, original_text, tailored_text):
    if not original_text or original_text == tailored_text:
        return False
        
    full_text = paragraph.text
    if original_text not in full_text:
        return False
        
    runs = paragraph.runs
    if not runs:
        paragraph.text = full_text.replace(original_text, tailored_text)
        return True

    for run in runs:
        if original_text in run.text:
            run.text = run.text.replace(original_text, tailored_text)
            return True

    combined_text = ""
    run_ranges = []
    for idx, run in enumerate(runs):
        start = len(combined_text)
        combined_text += run.text
        end = len(combined_text)
        run_ranges.append((idx, start, end))

    match_start = combined_text.find(original_text)
    if match_start == -1:
        return False
    match_end = match_start + len(original_text)

    affected_runs = []
    for idx, start, end in run_ranges:
        if max(start, match_start) < min(end, match_end):
            affected_runs.append(idx)

    if not affected_runs:
        return False

    first_idx = affected_runs[0]
    first_run = runs[first_idx]
    
    first_start, first_end = run_ranges[first_idx][1], run_ranges[first_idx][2]
    prefix = first_run.text[:match_start - first_start]
    
    last_idx = affected_runs[-1]
    last_run = runs[last_idx]
    last_start, last_end = run_ranges[last_idx][1], run_ranges[last_idx][2]
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

    for original_text, tailored_text in replacements:
        replaced = False
        for p in doc.paragraphs:
            if _replace_text_in_paragraph(p, original_text, tailored_text):
                replaced = True
                count += 1
                break
                
        if not replaced:
            for table in doc.tables:
                for row in table.rows:
                    for cell in row.cells:
                        for p in cell.paragraphs:
                            if _replace_text_in_paragraph(p, original_text, tailored_text):
                                replaced = True
                                count += 1
                                break
                        if replaced:
                            break
                    if replaced:
                        break
                if replaced:
                    break

    doc.save(output_path)
    return count

def extract_doc_text(doc_path):
    doc = docx.Document(doc_path)
    paragraphs_text = [p.text for p in doc.paragraphs if p.text.strip()]
    table_text = []
    for table in doc.tables:
        for row in table.rows:
            for cell in row.cells:
                for p in cell.paragraphs:
                    if p.text.strip():
                        table_text.append(p.text)
    return "\n".join(paragraphs_text + table_text)
