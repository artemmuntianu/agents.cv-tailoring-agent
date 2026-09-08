import os
import json
import docx

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

STATIC_CV_DATA = {
    "header": {
        "title": "Senior Software Engineer | Ex-TechLead | Ex-Founder"
    },
    "summary": "Senior Fullstack Engineer & Tech Lead with 13+ years of experience building high-traffic web applications, analytics platforms, microservices, and AI-driven solutions. Proven track record in modernizing large-scale enterprise systems using .NET Core, Angular, and AI-agent orchestration. Strong expertise in leading engineering teams, system architecture, and cloud services (Azure/GCP). Passionate about AI-native development, team performance, and building secure, scalable software.",
    "skills": {
        "AI & Agentic Workflows": "Multi-Agent Orchestration, Custom AI Agents, Prompt Engineering, MCP, n8n, Cursor, LLMs (OpenAI, Anthropic, Google AI).",
        "Frontend": "Angular, React, Next.js, Astro",
        "Backend": ".NET Core, Python, REST APIs, Microservices",
        "Databases & Cloud": "MSSQL Server, Postgres, Azure, GCP.",
        "Testing & DevOps": "Jest, Playwright.",
        "Leadership & Methodology": "System Architecture, Technical Planning, Team Mentoring, Agile/Scrum, Lean."
    },
    "professional_experience": [
        {
            "role": "AI-Native Senior Software Engineer",
            "company_info": "Codify Technologies | FinTech Project | Aug 2025 – Aug 2026",
            "highlights": [
                "Large-Scale FinTech Modernization: End-to-end migration of 50 desktop screens and 10 WCF services (300+ endpoints across 5 repos) from legacy WinForms to a modern web architecture (.NET Core REST APIs + Angular), executing a seamless transition via WebView2.",
                "Multi-Agent Architecture: Designed a multiagent orchestration framework using OpenAI & Anthropic models, accelerating migration by 50% and test creation by 80% while enforcing strict human-in-the-loop code ownership and integration in PROD.",
                "Architecture, Security & APIM Gateway: Authored technical specifications; deployed specialized subagents for direct SQL-to-StoredProcedure refactoring, WCF-to-REST conversion, and Azure API Management perimeter security policies.",
                "QA Automation Enablement: Formulated a comprehensive testing strategy (Jest + Playwright) and automated the injection of standardized automation-id attributes across UI components to empower e2e QA workflows."
            ]
        },
        {
            "role": "Founder",
            "company_info": "Datopus, Portugal | Product Analytics Platform | July 2024 – June 2025",
            "highlights": [
                "Established and directed an engineering team.",
                "Optimized workflow by implementing practices from Agile and Lean philosophies.",
            ]
        },
        {
            "role": "Tech Team Lead & Senior Software Engineer",
            "company_info": "Tangiblee, USA | Multiple projects | February 2013 – July 2024",
            "highlights": [
                "Led the technical design and development of high-traffic, customer-facing web applications using React, Angular and .NET, processing 2B+ monthly requests.",
                "Mentored a cross-functional Scrum team of 5 engineers, improving team code quality and increasing feature delivery speed by 25% through enhanced architectural guidance and best practices.",
                "Architected and implemented new microservices and REST APIs, improving system scalability by 2 times and supporting expansion into new international markets (e.g., LATAM, EU, APAC).",
                "Drove CI/CD adoption and DevOps mindset, resulting in a 50% increase in deployment frequency and a 25% reduction in time-to-market for new features.",
                "Collaborated with Stakeholders, Product, Marketing and UX teams, translating complex requirements into scalable technical solutions for enterprise-grade projects."
            ]
        }
    ]
}

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
