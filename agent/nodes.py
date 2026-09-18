import os
from datetime import datetime
from types import SimpleNamespace

from google import genai
from google.genai import types
from PIL import Image

import config
from agent.contracts import JobStatus
from agent.models import JobRoleExtraction, LayoutCheckResult, TextModificationList
from agent.state import State
from utils import db as db_module
from utils import storage as storage_module
from utils.docx_mutator import (
    apply_text_replacements,
    extract_doc_text,
    normalize_replacements,
    validate_cv_data_against_docx,
)
from utils.logging_setup import get_logger
from utils.renderer import convert_docx_to_pdf, convert_pdf_to_images
from utils.retry import retry_with_exponential_backoff

log = get_logger(__name__)


def _job_log(state: State):
    return log.bind(
        job_id=state.get("job_id") or "-",
        external_id=state.get("external_id") or "-",
        attempt=state.get("attempt", 0),
    )


def _set_status(state: State, status: str, **extra) -> None:
    """Persist a status transition so Supabase Realtime can push it.

    Never fatal: local CLI runs have no job_id and a DB hiccup must not kill a
    task that is otherwise making progress.
    """
    job_id = state.get("job_id")
    if not job_id:
        return
    try:
        db_module.get_db().update_job(job_id, status=status, **extra)
    except Exception as exc:  # noqa: BLE001
        _job_log(state).warning("could not persist job status", status=status, error=str(exc))


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
    job_log = _job_log(state)
    job_log.info("node started", node="adapt_text", revision=state["revision_count"] + 1)
    _set_status(state, JobStatus.PROCESSING)
    client = get_genai_client()

    cv_data = state.get("cv_data") or None
    cv_text = extract_doc_text(cv_data)

    # Contract check from the architecture doc: cv_data.json must describe the
    # master cv.docx, otherwise AST mutations could target the wrong paragraph.
    if cv_data and not state.get("skip_cv_sync_check"):
        missing = validate_cv_data_against_docx(cv_data, state["cv_path"])
        if missing:
            job_log.error("master cv sync check failed", missing=missing[:5])
            raise ValueError(
                "cv_data.json is out of sync with the master cv.docx "
                f"({len(missing)} line(s) not found, e.g. {missing[:2]!r})"
            )

    target_role_title = state.get("target_role_title")
    if not target_role_title:
        target_role_title = _call_gemini_extract_role(client, state["job_description"])
        job_log.info("target role extracted", target_role_title=target_role_title)

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
    raw_replacements = [
        (m.original_text, m.tailored_text, getattr(m, "reason", "N/A"))
        for m in mod_result.modifications
    ]
    # Normalise so the model can never pass a concatenated (multi-line) label+value
    # as a single replacement - those live in separate paragraphs and can never match.
    replacements = normalize_replacements(raw_replacements)

    applied_count = apply_text_replacements(
        doc_path=state["cv_path"],
        replacements=replacements,
        output_path=state["output_path"],
    )
    job_log.info(
        "text replacements written to docx",
        applied=applied_count,
        suggested=len(replacements),
    )

    mod_dicts = [
        {
            "original_text": r_orig,
            "tailored_text": r_tail,
            "reason": r_reason,
        }
        for r_orig, r_tail, r_reason in replacements
    ]

    if applied_count == 0:
        job_log.warning("no text replacements could be applied to the docx - stopping")
        return {
            **state,
            "target_role_title": target_role_title,
            "current_cv_text": cv_text,
            "modifications": mod_dicts,
            "revision_count": state["revision_count"] + 1,
            "is_approved": True,
            "status_hint": JobStatus.SKIPPED,
            "layout_feedback": "Stopped: No text replacements applied to DOCX.",
        }

    return {
        **state,
        "target_role_title": target_role_title,
        "current_cv_text": cv_text,
        "modifications": mod_dicts,
        "revision_count": state["revision_count"] + 1,
    }


def render(state: State) -> State:
    job_log = _job_log(state)
    _set_status(state, JobStatus.RENDERING)
    temp_dir = state.get("temp_dir") or "temp"
    os.makedirs(temp_dir, exist_ok=True)
    pdf_path = os.path.join(temp_dir, "temp_rendered.pdf")
    # Per-job LibreOffice profile: avoids profile locks if two conversions ever
    # share a node.
    profile_dir = os.path.join(temp_dir, "lo-profile")

    convert_docx_to_pdf(state["output_path"], pdf_path, profile_dir=profile_dir)
    images_dir = os.path.join(temp_dir, "rendered_pages")
    image_paths = convert_pdf_to_images(pdf_path, images_dir, dpi=config.RENDER_DPI)
    job_log.info(
        "pages rendered",
        pages=len(image_paths),
        dpi=config.RENDER_DPI,
        pdf_path=pdf_path,
    )

    return {
        **state,
        "image_paths": image_paths,
        "pdf_path": pdf_path,
    }


def vision_check(state: State) -> State:
    job_log = _job_log(state)
    _set_status(state, JobStatus.VALIDATING)
    job_log.info("node started", node="vision_check")
    client = get_genai_client()

    images = []
    for path in state["image_paths"]:
        with Image.open(path) as image:
            image.load()
            images.append(image.copy())

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
    try:
        result = _call_gemini_vision_eval(client, [*images, prompt])
    finally:
        for image in images:
            image.close()

    if result.is_layout_ok:
        job_log.info("visual check passed", feedback=result.feedback)
    else:
        job_log.warning("visual check flagged layout issues", feedback=result.feedback)

    return {
        **state,
        "is_approved": result.is_layout_ok,
        "layout_feedback": result.feedback,
    }


def persist(state: State) -> State:
    """Terminal node: upload artifacts and write the final row.

    The message is only acked after this node returns, so a crash here simply
    re-delivers the task instead of losing the result.
    """
    job_log = _job_log(state)
    job_log.info("node started", node="persist")
    _set_status(state, JobStatus.UPLOADING)

    status = state.get("status_hint") or JobStatus.COMPLETED
    pdf_url = state.get("pdf_url") or ""
    docx_url = state.get("docx_url") or ""

    if state.get("job_id"):
        task = SimpleNamespace(
            job_id=state.get("job_id"),
            user_id=state.get("user_id") or None,
            external_id=state.get("external_id") or "cv",
        )
        storage = storage_module.get_storage()
        pdf_path = state.get("pdf_path")
        if pdf_path and os.path.exists(pdf_path):
            pdf_url = storage.upload(
                pdf_path, storage_module.output_key_for(task, ".pdf"), storage_module.PDF_MIME
            )
        if state.get("output_path") and os.path.exists(state["output_path"]):
            docx_url = storage.upload(
                state["output_path"],
                storage_module.output_key_for(task, ".docx"),
                storage_module.DOCX_MIME,
            )

    duration_ms = None
    if state.get("started_at"):
        try:
            started = datetime.fromisoformat(state["started_at"])
            duration_ms = int((datetime.now(started.tzinfo) - started).total_seconds() * 1000)
        except Exception:  # noqa: BLE001
            duration_ms = None

    _set_status(
        state,
        status,
        revision_count=state.get("revision_count"),
        is_approved=bool(state.get("is_approved")),
        pdf_url=pdf_url or None,
        docx_path=docx_url or None,
        duration_ms=duration_ms,
    )
    job_log.info(
        "job finished",
        status=status,
        pdf_url=pdf_url,
        duration_ms=duration_ms,
        revisions=state.get("revision_count"),
    )

    return {
        **state,
        "pdf_url": pdf_url,
        "docx_url": docx_url,
        "status_hint": status,
    }
