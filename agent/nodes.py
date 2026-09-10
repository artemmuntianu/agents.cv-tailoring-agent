import os
from PIL import Image
from google import genai
from google.genai import types
import config
from agent.state import State
from agent.models import TextModificationList, LayoutCheckResult, JobRoleExtraction
from utils.retry import retry_with_exponential_backoff
from utils.docx_mutator import extract_doc_text, apply_text_replacements, normalize_replacements
from utils.renderer import convert_docx_to_pdf, convert_pdf_to_images

@retry_with_exponential_backoff
def _call_gemini_extract_role(client, job_description: str) -> str:
    prompt = f"""Extract the exact or primary target role title from this job description.
Return json matching schema with target_role_title.

JOB DESCRIPTION:
{job_description}"""
    response = client.models.generate_content(
        model=config.MODEL_NAME,
        contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=JobRoleExtraction,
            temperature=0.0,
        ),
    )
    res = JobRoleExtraction.model_validate_json(response.text)
    return res.target_role_title.strip()

@retry_with_exponential_backoff
def _call_gemini_text_adaptation(client, prompt):
    response = client.models.generate_content(
        model=config.MODEL_NAME,
        contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=TextModificationList,
            temperature=0.2,
        ),
    )
    return TextModificationList.model_validate_json(response.text)

@retry_with_exponential_backoff
def _call_gemini_vision_eval(client, contents):
    response = client.models.generate_content(
        model=config.MODEL_NAME,
        contents=contents,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=LayoutCheckResult,
            temperature=0.1,
        ),
    )
    return LayoutCheckResult.model_validate_json(response.text)

def get_genai_client():
    if getattr(config, "GEMINI_API_KEY", None):
        return genai.Client(api_key=config.GEMINI_API_KEY)
    return genai.Client()

def adapt_text(state: State) -> State:
    print(f"\n✏️  [Node: adapt_text] Starting revision #{state['revision_count'] + 1}...")
    client = get_genai_client()
    cv_text = extract_doc_text(state["cv_path"])
    
    target_role_title = state.get("target_role_title")
    if not target_role_title:
        target_role_title = _call_gemini_extract_role(client, state["job_description"])
        print(f"🎯 [Role Extraction] Extracted Target Role Title: '{target_role_title}'")

    prompt = f"""You are a professional CV tailoring expert optimising a candidate's resume to maximise alignment with a target job description AND to pass Applicant Tracking System (ATS) screening - while NEVER fabricating anything.

You receive the candidate's CURRENT CV TEXT, which contains these sections in order:
- HEADER (NAME + TITLE)
- SUMMARY
- RELEVANT SKILLS (labelled categories - each category label and its skills value are SEPARATE single-line paragraphs)
- PROFESSIONAL EXPERIENCE (role, company_info, bullet highlights)

TARGET ROLE TITLE FROM JOB DESCRIPTION:
"{target_role_title}"

MISSION:
Produce text replacements for EVERY relevant section so the resume surfaces the exact keywords and responsibilities the job description requests. You MUST cover ALL of the following sections; do not skip any that exist in the CV text:
1. HEADER_TITLE
2. SUMMARY
3. SKILLS
4. PROFESSIONAL_EXPERIENCE (role lines and highlight bullets)

RULES:
1. NO FABRICATION (HARD RULE): NEVER invent employers, job titles, dates, companies, projects, certifications, technologies, or metrics that are absent from the CURRENT CV TEXT. Only rephrase and re-weight what already exists. Never claim a technology the candidate has not used. Never alter a real figure (e.g. "2B+", "50%", "80%", "2 times", "300+ endpoints") into a different number, and never add a number that is not in the source.
2. ATS KEYWORD MATCHING: Rephrase so the exact phrases the job description uses surface naturally as scannable tokens (e.g. "Solution Architect", "Azure", ".NET", "REST API design", "MS SQL Server", "architecture artifacts", "C4 / ADR / HLD / LLD", "security (JWT, OAuth2/OIDC, Key Vault, least-privilege)", "AI/LLM concepts (RAG, embeddings, prompt engineering)", "event-driven architecture", "Service Bus / Event Grid", "clean/onion architecture, Repository, CQRS", "Docker / AKS", "observability (Application Insights)"). Only surface a term if it is genuinely backed by the candidate's real experience.
3. SUMMARY: Rewrite it (3-5 lines) to lead with the target role title and the top 3-5 MUST-HAVE requirements, framed as proven capability. Keep it strictly factual - do not claim deep mastery of something not evidenced on the CV.
4. SKILLS: Reword the category labels AND each skills value line SEPARATELY - a label and its value are two separate target lines, so rephrase each independently so the job description's keywords become the visible tokens (e.g. Azure services, .NET/C#, REST API design & contracts, MS SQL Server design/tuning, AI & LLM: RAG / embeddings / prompt engineering / agentic orchestration, architecture patterns). Do not add new technologies.
5. HEADER_TITLE: MUST adapt the title to closely match the target role while preserving the candidate's genuine seniority, e.g. "Senior Solution Architect (.NET / Azure) | AI-Native Engineering Lead". Keep the candidate's NAME unchanged. If the job title differs from the current title, it MUST be adapted.
6. PROFESSIONAL_EXPERIENCE: Rephrase each highlight using the (Action + Context + Result) formula, front-loading the job description's responsibility keywords (end-to-end solution design, REST API contracts, MS SQL Server schema/performance, Azure cloud architecture, architecture artifacts & clear documentation, communicating trade-offs). Keep every real metric exactly as-is.
7. Keep each replacement readable and roughly the same length as the original. Do not merge, split, or drop bullets; keep the same count and order of experience entries.
8. SINGLE-LINE (HARD RULE): original_text and tailored_text must each be EXACTLY ONE line and must NEVER contain a newline ('\n') or carriage return character. Each replacement targets exactly ONE paragraph/line of the DOCX. A SKILLS category label and its skills value are TWO separate single-line paragraphs - if you revise both, return TWO separate replacement entries (one for the label line, one for the value line). NEVER concatenate a category label with its value (or any two lines) into a single multi-line original_text - that can never match the DOCX.
9. VERBATIM: original_text MUST be an EXACT verbatim single-line string copied from the CURRENT CV TEXT (a full bullet, the header/title line, a SKILLS category label, or a SKILLS value line). reason must state which job-description requirement the change now targets.
10. BULLET MARKERS (HARD RULE): NEVER include a bullet or list marker character at the start of either original_text or tailored_text - no '•', '-', '*', 'o', '–' or '—'. Microsoft Word renders the list bullets automatically, so a leading marker produces a DOUBLE bullet. Provide ONLY the plain sentence text (e.g. "Led the migration of 50 desktop screens…", never "• Led the migration…"). In the provided CV text, highlight bullets are prefixed with a '•' purely for display in this plain-text dump - IGNORE that marker when you copy original_text and NEVER echo it into tailored_text.
"""
    if state.get("layout_feedback"):
        prompt += f"\nCRITICAL VISUAL FEEDBACK FROM PREVIOUS LAYOUT INSPECTION:\n{state['layout_feedback']}\nAdjust phrases to be more concise to fix page overflow and widow/orphan lines."

    prompt += f"\n\nCURRENT CV TEXT:\n{cv_text}\n\nJOB DESCRIPTION:\n{state['job_description']}"

    mod_result = _call_gemini_text_adaptation(client, prompt)
    raw_replacements = [(m.original_text, m.tailored_text, getattr(m, "reason", "N/A")) for m in mod_result.modifications]
    # Normalise so the model can never pass a concatenated (multi-line) label+value
    # as a single replacement - those live in separate paragraphs and can never match.
    replacements = normalize_replacements(raw_replacements)

    applied_count = apply_text_replacements(
        doc_path=state["cv_path"],
        replacements=replacements,
        output_path=state["output_path"]
    )
    print(f"\n✅ Total Applied: {applied_count}/{len(replacements)} text replacement(s) successfully written to DOCX.")

    mod_dicts = [
        {
            "original_text": r_orig,
            "tailored_text": r_tail,
            "reason": r_reason,
        }
        for r_orig, r_tail, r_reason in replacements
    ]

    if applied_count == 0:
        print("⚠️  No text replacements could be applied to the DOCX. Stopping process.")
        return {
            **state,
            "target_role_title": target_role_title,
            "current_cv_text": cv_text,
            "modifications": mod_dicts,
            "revision_count": state["revision_count"] + 1,
            "is_approved": True,
            "layout_feedback": "Stopped: No text replacements applied to DOCX."
        }

    return {
        **state,
        "target_role_title": target_role_title,
        "current_cv_text": cv_text,
        "modifications": mod_dicts,
        "revision_count": state["revision_count"] + 1
    }

def render(state: State) -> State:
    print(f"📄 [Node: render] Converting DOCX to PDF and rendering low-res PNGs...")
    temp_dir = state.get("temp_dir", "temp")
    os.makedirs(temp_dir, exist_ok=True)
    pdf_path = os.path.join(temp_dir, "temp_rendered.pdf")
    
    convert_docx_to_pdf(state["output_path"], pdf_path)
    images_dir = os.path.join(temp_dir, "rendered_pages")
    image_paths = convert_pdf_to_images(pdf_path, images_dir, dpi=config.RENDER_DPI)
    print(f"🖼️  Generated {len(image_paths)} page preview PNG(s) at {config.RENDER_DPI} DPI.")
    
    return {
        **state,
        "image_paths": image_paths
    }

def vision_check(state: State) -> State:
    print(f"👁️  [Node: vision_check] Evaluating visual document layout with Gemini Vision...")
    client = get_genai_client()
    
    pil_images = [Image.open(p) for p in state["image_paths"]]
    
    prompt = """Analyze the rendered CV page images for formatting quality and visual layout.

IMPORTANT LAYOUT GUIDELINES:
* Layout & Page Flow: Accept two-column design with sidebar ending on page 1. Allow natural overflow to page 2 (even partial pages or multi-page entry splits). Never propose margin, font, or spacing tweaks for page fitting.
* Ignore Design Non-Issues: Do not flag orphan lines, minor overflows, or the intentional overlap between 'AI & Agentic Workflows' and the 'RELEVANT SKILLS' header background bar.
* Focus & Scope: Flag only severe structural or visual defects. Prioritize content readability, technical accuracy, and structural hierarchy over page count.
* NEVER try to condense the content to fit comfortably onto a single page.

Return json matching schema with fields:
- is_layout_ok: boolean
- feedback: string explanation of layout issues (if any) or confirmation of clean layout.
"""
    contents = [*pil_images, prompt]
    result = _call_gemini_vision_eval(client, contents)
    
    if result.is_layout_ok:
        print(f"✅ Visual check passed! Feedback: {result.feedback}")
    else:
        print(f"⚠️  Visual check flagged layout issues: {result.feedback}")

    return {
        **state,
        "is_approved": result.is_layout_ok,
        "layout_feedback": result.feedback
    }
