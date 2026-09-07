import os
import json
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


STATIC_CV_DATA = {
    "header": {
        "name": "ARTEM MUNTIANU",
        "title": "AI-Native Senior Software Engineer | Tech Lead"
    },
    "summary": "Senior Fullstack Engineer & Tech Lead with 13+ years of experience building high-traffic web applications, analytics platforms, microservices, and AI-driven solutions. Proven track record in modernizing large-scale enterprise systems using .NET Core, Angular, and AI-agent orchestration. Strong expertise in leading engineering teams, system architecture, and cloud services (Azure/GCP). Passionate about AI-native development, team performance, and building secure, scalable software.",
    "skills": {
        "AI & Agentic Workflows": "Multi-Agent Orchestration, Custom AI Agents, Prompt Engineering, MCP, n8n, Cursor, LLMs (OpenAI, Anthropic, Google AI).",
        "Frontend": "Angular, React, Next.js, Astro",
        "Backend": ".NET Core, REST APIs, Microservices",
        "Databases & Cloud": "MSSQL Server, Postgres, Azure, GCP.",
        "Testing & DevOps": "Jest, Playwright.",
        "Leadership & Methodology": "System Architecture, Technical Planning, Team Mentoring, Agile/Scrum, Lean."
    },
    "education": [
        {
            "degree": "MSc in Software Engineering",
            "institution": "Ukraine National University",
            "period": "2007 – 2012"
        }
    ],
    "contact": {
        "email": "artemmuntianu@gmail.com",
        "linkedin": "linkedin.com/in/artematdatopus",
        "location": "Portugal",
        "phone": "(+351) 913 316 091"
    },
    "languages": {
        "English": "B2 (Upper-Intermediate)",
        "Portuguese": "A1",
        "Ukrainian": "Native"
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
                "Led the full development lifecycle for two critical business websites: Sales Website: Developed with Next.js, React, and deployed on Azure; Analytics Web Portal: Built using .NET, Angular, and deployed on Azure with GCP integration."
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
        f"{STATIC_CV_DATA['header']['name']} - {STATIC_CV_DATA['header']['title']}",
        "\nSUMMARY:",
        STATIC_CV_DATA['summary'],
        "\nRELEVANT SKILLS:"
    ]
    for category, skills in STATIC_CV_DATA['skills'].items():
        lines.append(f"- {category}: {skills}")
        
    lines.append("\nPROFESSIONAL EXPERIENCE:")
    for exp in STATIC_CV_DATA['professional_experience']:
        lines.append(f"\n{exp['role']}")
        lines.append(f"{exp['company_info']}")
        for h in exp['highlights']:
            lines.append(f"• {h}")
            
    lines.append("\nEDUCATION:")
    for edu in STATIC_CV_DATA['education']:
        lines.append(f"{edu['degree']}, {edu['institution']} ({edu['period']})")
        
    lines.append("\nCONTACT:")
    for k, v in STATIC_CV_DATA['contact'].items():
        lines.append(f"{k.capitalize()}: {v}")
        
    lines.append("\nLANGUAGES:")
    for lang, level in STATIC_CV_DATA['languages'].items():
        lines.append(f"{lang}: {level}")
        
    return "\n".join(lines)

def extract_doc_text(doc_path=None):
    if doc_path and os.path.exists(doc_path):
        doc = docx.Document(doc_path)
        paragraphs_text = [p.text for p in doc.paragraphs if p.text.strip()]
        table_text = []
        for table in doc.tables:
            for row in table.rows:
                for cell in row.cells:
                    for p in cell.paragraphs:
                        if p.text.strip():
                            table_text.append(p.text)
        if paragraphs_text or table_text:
            return "\n".join(paragraphs_text + table_text)
            
    return get_encoded_cv_text()
