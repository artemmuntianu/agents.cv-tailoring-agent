"""The adaptation stage: `adapt_text` and `render`.

The rest of the graph sits beside this file, one concern per module (the 250-line module rule):
`agent/tailoring_prompt.py` (the rules), `agent/gemini.py` (the client and the three calls),
`agent/vision.py` (`vision_check`), `agent/persist.py` and `agent/verification.py` (the 0%-lies
check that filters what the model proposes). `agent/graph.py` wires them.

`adapt_text` is where the three inputs meet: the master CV model (sync-checked against the DOCX),
the vacancy, and the operator's candidate facts - evidence the CV text may not spell out.
"""

import os

import config
from agent import gemini
from agent.contracts import JobStatus
from agent.job_log import job_logger, set_status
from agent.state import State
from agent.tailoring_prompt import build_tailoring_prompt
from agent.verification import evaluate_fabrications
from utils import candidate as candidate_module
from utils import db as db_module
from utils.cv_replacements import drop_read_only_replacements, normalize_replacements
from utils.cv_text import extract_doc_text, load_cv_data
from utils.docx_mutator import apply_text_replacements, validate_cv_data_against_docx
from utils.logging_setup import get_logger
from utils.renderer import convert_docx_to_pdf, convert_pdf_to_images

log = get_logger(__name__)


def adapt_text(state: State) -> State:
    job_log = job_logger(state)
    job_log.info("node started", node="adapt_text", revision=state["revision_count"] + 1)
    set_status(state, JobStatus.PROCESSING)
    client = gemini.client()

    cv_data = state.get("cv_data") or None
    # `extract_doc_text()` would load the file itself; loading it here keeps ONE copy, so the
    # read-only guard below reasons about the very model the prompt was built from.
    if cv_data is None:
        cv_data = load_cv_data()
    cv_text = extract_doc_text(cv_data)

    # The candidate facts (the operator's own profile row) are the third input: ground truth
    # about experience the CV text does not spell out. No user id (a CLI run) or no row is not
    # an error - the prompt then simply carries an empty facts block.
    try:
        candidate_facts = candidate_module.load(db_module.get_db(), state.get("user_id"))
    except Exception as exc:  # noqa: BLE001 - a missing profile must never fail a run
        job_log.warning("could not read the candidate facts", error=str(exc))
        candidate_facts = {}
    candidate_digest = candidate_module.digest(candidate_facts) if candidate_facts else ""

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
        target_role_title = gemini.extract_role(client, state["job_description"])
        job_log.info("target role extracted", target_role_title=target_role_title)

    prompt = build_tailoring_prompt(
        target_role_title=target_role_title,
        cv_text=cv_text,
        job_description=state["job_description"],
        candidate_digest=candidate_digest,
        layout_feedback=state.get("layout_feedback") or "",
    )

    mod_result = gemini.suggest_replacements(client, prompt)
    raw_replacements = [
        (m.original_text, m.tailored_text, getattr(m, "reason", "N/A"))
        for m in mod_result.modifications
    ]

    # Deterministic Fabrication Verification (0% Lies Check)
    jd_text = state.get("job_description", "")
    eval_res = evaluate_fabrications(
        cv_text, raw_replacements, job_description=jd_text, ground_truth=candidate_digest
    )
    if eval_res.violations:
        job_log.warning(
            "fabrications detected in initial LLM output - requesting self-healing retry",
            lie_percentage=eval_res.lie_percentage,
            violations=eval_res.violations,
        )
        retry_prompt = prompt + (
            "\n\nCRITICAL DETERMINISTIC VERIFICATION DETECTED FABRICATIONS ('LIES') (Rule 4 violation):\n"
            + "\n".join(f"- {v}" for v in eval_res.violations)
            + "\n\nFix the replacements above so that NO invented metrics, altered numbers, or unlisted technologies remain. Fabrication count MUST be 0."
        )
        try:
            retry_result = gemini.suggest_replacements(client, retry_prompt)
            retry_raw = [
                (m.original_text, m.tailored_text, getattr(m, "reason", "N/A"))
                for m in retry_result.modifications
            ]
            eval_res = evaluate_fabrications(
                cv_text, retry_raw, job_description=jd_text, ground_truth=candidate_digest
            )
        except Exception as retry_err:  # noqa: BLE001
            job_log.warning("self-healing fabrication retry failed", error=str(retry_err))

    # Strict Guarantee: Filter out any remaining replacements that contain fabrications (0% lies)
    clean_raw_replacements = [
        (item.original_text, item.tailored_text, getattr(item, "reason", "N/A"))
        if hasattr(item, "original_text")
        else item
        for item in eval_res.clean_replacements
    ]
    job_log.info(
        "deterministic fabrication verification complete",
        initial_lies=len(eval_res.violations),
        final_lie_percentage=0.0 if not eval_res.violations else eval_res.lie_percentage,
        retained_replacements=len(clean_raw_replacements),
    )

    # Normalise so the model can never pass a concatenated (multi-line) label+value
    # as a single replacement - those live in separate paragraphs and can never match.
    replacements = normalize_replacements(clean_raw_replacements)
    # Projects are context, not targets: the prompt states it, this is the enforcement.
    replacements = drop_read_only_replacements(replacements, cv_data)

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
    job_log = job_logger(state)
    set_status(state, JobStatus.RENDERING)
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
