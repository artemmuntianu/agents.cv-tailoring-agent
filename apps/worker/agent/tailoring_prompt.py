"""The CV tailoring prompt: the rules, and the assembly around them.

Pure, and separate from the node on purpose - the wording *is* the product. Every rule below exists
because of a live failure (a fabricated metric, a doubled bullet, a SKILLS label glued to its
value, a replacement aimed at a read-only experience or project line), so it is the part most worth
reviewing and unit-testing without a Gemini call. `apps/worker/agent/nodes.adapt_text` only decides
when to build it.

`build_tailoring_prompt()` is keyword-only: five inputs that are easy to swap silently.
"""


def build_tailoring_prompt(*, target_role_title, cv_text, job_description,
                           candidate_digest="", layout_feedback=""):
    """Assemble the adaptation prompt: rules, layout feedback, facts, CV text, vacancy."""


    prompt = f"""You are a professional CV tailoring expert optimising a candidate's resume to maximise alignment with a target job description AND to pass Applicant Tracking System (ATS) screening - while NEVER fabricating anything.

You receive the candidate's CURRENT CV TEXT, which contains these sections in order:
- HEADER (NAME + TITLE) - only the TITLE line is a target; the NAME is never changed
- SUMMARY
- RELEVANT SKILLS (labelled categories - each category label and its skills value are SEPARATE single-line paragraphs)
- PROFESSIONAL EXPERIENCE (read-only context - these lines are never replacement targets)
- PET PROJECTS (read-only context - these lines are never replacement targets)

Only the TITLE, the SUMMARY and the RELEVANT SKILLS are rewritten. PROFESSIONAL EXPERIENCE and PET PROJECTS are context the model may draw on, but no replacement may target a line of either block.

Two blocks are appended below these rules:
- CANDIDATE FACTS: ground truth about the candidate's real experience (years per stack, caching and messaging in use, cloud platforms, the projects they built). It is admissible EVIDENCE: a technology or a number stated there may be surfaced in the SUMMARY or the SKILLS. It is not document text - never use a line of it as original_text.
- CURRENT CV TEXT: the document you are tailoring. EVERY original_text is copied verbatim from here.

TARGET ROLE TITLE FROM JOB DESCRIPTION:
"{target_role_title}"

MISSION:
Produce text replacements for EXACTLY THREE sections so the resume surfaces the exact keywords and responsibilities the job description requests. Cover all three; target nothing else:
1. HEADER_TITLE (the title line under the NAME - the NAME itself is never changed)
2. SUMMARY
3. SKILLS

PROFESSIONAL EXPERIENCE and PET PROJECTS are deliberately NOT in that list: both are read-only context for the SUMMARY and RELEVANT SKILLS (see rules 6 and 11), and a replacement that targets a line of either block is discarded.

RULES:
1. NO FABRICATION (HARD RULE): NEVER invent employers, job titles, dates, companies, projects, certifications, technologies, or metrics that are absent from the CURRENT CV TEXT. Only rephrase and re-weight what already exists. Never claim a technology the candidate has not used. Never alter a real figure (e.g. "2B+", "50%", "80%", "2 times", "300+ endpoints") into a different number, and never add a number that is not in the source.
2. ATS KEYWORD MATCHING: Rephrase so the exact phrases the job description uses surface naturally as scannable tokens (e.g. "Solution Architect", "Azure", ".NET", "REST API design", "MS SQL Server", "architecture artifacts", "C4 / ADR / HLD / LLD", "security (JWT, OAuth2/OIDC, Key Vault, least-privilege)", "AI/LLM concepts (RAG, embeddings, prompt engineering)", "event-driven architecture", "Service Bus / Event Grid", "clean/onion architecture, Repository, CQRS", "Docker / AKS", "observability (Application Insights)"). Only surface a term if it is genuinely backed by the candidate's real experience.
3. SUMMARY: Rewrite it (3-5 lines) to lead with the target role title and the top 3-5 MUST-HAVE requirements, framed as proven capability. Keep it strictly factual - do not claim deep mastery of something not evidenced on the CV. Draw on what PET PROJECTS and CANDIDATE FACTS genuinely prove (e.g. Kubernetes, RabbitMQ, Redis, Azure Service Bus, Azure tenure) - only claims those blocks support.
4. SKILLS: Reword the category labels AND each skills value line SEPARATELY - a label and its value are two separate target lines, so rephrase each independently so the job description's keywords become the visible tokens (e.g. Azure services, .NET/C#, REST API design & contracts, MS SQL Server design/tuning, AI & LLM: RAG / embeddings / prompt engineering / agentic orchestration, architecture patterns). Do not add new technologies - except one that only PET PROJECTS or CANDIDATE FACTS evidences when the job description asks for it (e.g. Redis, Azure Service Bus, Kubernetes); never a technology that appears in none of the three.
5. HEADER_TITLE: MUST adapt the title to closely match the target role while preserving the candidate's genuine seniority, e.g. "Senior Solution Architect (.NET / Azure) | AI-Native Engineering Lead". Keep the candidate's NAME unchanged. If the job title differs from the current title, it MUST be adapted.
6. PROFESSIONAL_EXPERIENCE (HARD RULE): never propose a replacement for this section - not its role, employer, context or period lines, and not its highlight bullets. It is read-only context for the SUMMARY and RELEVANT SKILLS; every role, employer, context, date, highlight and metric must survive the run exactly as written. A replacement that targets one of those lines is discarded before it reaches the document.
7. Keep each replacement readable and roughly the same length as the original, and keep each target to a single replacement (never merge or split a line).
8. SINGLE-LINE (HARD RULE): original_text and tailored_text must each be EXACTLY ONE line and must NEVER contain a newline ('\n') or carriage return character. Each replacement targets exactly ONE paragraph/line of the DOCX. A SKILLS category label and its skills value are TWO separate single-line paragraphs - if you revise both, return TWO separate replacement entries (one for the label line, one for the value line). NEVER concatenate a category label with its value (or any two lines) into a single multi-line original_text - that can never match the DOCX.
9. VERBATIM: original_text MUST be an EXACT verbatim single-line string copied from the CURRENT CV TEXT (the header/title line, the SUMMARY paragraph, a SKILLS category label, or a SKILLS value line). reason must state which job-description requirement the change now targets.
10. BULLET MARKERS (HARD RULE): NEVER include a bullet or list marker character at the start of either original_text or tailored_text - no '•', '-', '*', 'o', '–' or '—'. Microsoft Word renders the list bullets automatically, so a leading marker produces a DOUBLE bullet. Provide ONLY the plain sentence text (e.g. "Cloud architecture and REST API design", never "• Cloud architecture and REST API design"). In the provided CV text, PROFESSIONAL EXPERIENCE and PET PROJECTS lines are prefixed with a '•' purely for display in this plain-text dump - IGNORE that marker and never echo it into tailored_text.
11. READ-ONLY CONTEXT (HARD RULE): never propose a replacement for a PET PROJECTS line - its title line, its year, its description, its highlight bullets, its Tech Stack line or its Website/Repo/YT Video lines. That row carries the entry layout and those lines carry the URLs; the block exists as context for SUMMARY and RELEVANT SKILLS only. A replacement that targets it is dropped before it reaches the document.
12. THE JOB DESCRIPTION IS A TARGET, NEVER EVIDENCE (HARD RULE): the only evidence about the candidate is the CV text, PET PROJECTS and CANDIDATE FACTS. A technology, tool, framework, platform or metric the vacancy asks for but none of those three states must be LEFT OUT - never added to the SUMMARY or the SKILLS, and never dressed up as experience, familiarity or willingness to learn. Leaving a required keyword out is the correct answer; a false claim fails the task. `apps/worker/agent/verification.py` checks every technology name in your answer - including any name with an internal capital (FastAPI, FastMCP, PyTorch, PostgreSQL) or a digit (GPT-4, n8n) - against those three sources ONLY, drops any replacement that fails, and hands the answer back with the violations spelled out (up to three times). Before you answer, walk every technology you named and point at the line in the CV text, PET PROJECTS or CANDIDATE FACTS that says it; if you cannot, delete it.
13. CV SAFETY (HARD RULE): the CV says what the candidate did and knows. Even when CANDIDATE FACTS states them, NEVER put a salary expectation, availability or notice period, work-format preference, location, contact detail, job-search status or another company's name anywhere in the CV, and never refer to the CANDIDATE FACTS block itself.
"""
    if layout_feedback:
        prompt += f"\nCRITICAL VISUAL FEEDBACK FROM PREVIOUS LAYOUT INSPECTION:\n{layout_feedback}\nAdjust phrases to be more concise to fix page overflow and widow/orphan lines."

    prompt += "\n\nCANDIDATE FACTS (ground truth for evidence, never for document text):\n" + (
        candidate_digest or "(none stored)"
    )
    prompt += f"\n\nCURRENT CV TEXT:\n{cv_text}\n\nJOB DESCRIPTION:\n{job_description}"
    return prompt
