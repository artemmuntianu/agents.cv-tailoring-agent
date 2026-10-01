"""`verify_document`: the last line of defence - the produced file is judged before it is durable.

The replacement check (`agent/verification.py`) only ever sees what the model *proposed*. This node
reads the DOCX that was actually written - every paragraph of it - and runs the same rule over the
whole thing, so a claim that reached the file by any other route (a stray paragraph, a section the
prompt never listed, text no grader looked at) cannot be uploaded.

It sits between `vision_check` and `persist` for that reason: `persist` is what makes an artifact
durable, and a document claiming a technology the CV text and the candidate facts do not state must
never become one. The task **fails loudly** instead - the operator sees the exact claim, which is
the only honest answer when the alternative is a CV that lies about the candidate.

2026-10-01 is why this node exists: `FastAPI` and `FastMCP` reached a delivered CV because the job
description was treated as evidence and neither token was in the vocabulary the check looked for.
Both are fixed in `verification.py`; this node is what makes the guarantee hold for the file rather
than for the patch list.
"""

import os

import docx

from agent.contracts import JobStatus
from agent.job_log import job_logger, set_status
from agent.state import State
from agent.verification import scan_document_for_fabrications
from utils import candidate as candidate_module
from utils import db as db_module
from utils.cv_text import extract_doc_text, load_cv_data
from utils.docx_mutator import iter_all_paragraphs
from utils.logging_setup import get_logger

log = get_logger(__name__)


def read_docx_text(docx_path: str) -> str:
    """Every paragraph of one DOCX as text - the mutator's own view of the document."""
    document = docx.Document(docx_path)
    return "\n".join(paragraph.text for paragraph in iter_all_paragraphs(document))


def verify_document(state: State) -> State:
    job_log = job_logger(state)
    job_log.info("node started", node="verify_document")
    set_status(state, JobStatus.VALIDATING)

    document_path = state.get("output_path") or ""
    if not document_path or not os.path.exists(document_path):
        # Nothing to read: `adapt_text` produced nothing or the file is gone. That is a broken run
        # rather than a claim to judge, and `persist` is the node that reports it.
        job_log.warning("no document to verify", path=document_path)
        return state

    cv_data = state.get("cv_data") or load_cv_data()
    cv_text = extract_doc_text(cv_data)

    # The evidence is read here rather than carried in the state on purpose: this node must not be
    # foolable by a state that forgot to pass it. Same source as `adapt_text` uses.
    try:
        facts = candidate_module.load(db_module.get_db(), state.get("user_id"))
    except Exception as exc:  # noqa: BLE001 - a missing profile must never fail a run
        job_log.warning("could not read the candidate facts", error=str(exc))
        facts = {}
    digest = candidate_module.digest(facts) if facts else ""

    document_text = read_docx_text(document_path)
    violations = scan_document_for_fabrications(document_text, cv_text, digest)
    if violations:
        job_log.error(
            "the produced document claims something the evidence does not back",
            violations=violations[:5],
            characters=len(document_text),
        )
        raise ValueError(
            "refusing to upload a document with an unbacked claim: " + "; ".join(violations[:3])
        )

    job_log.info("document verified", characters=len(document_text), violations=0)
    return state
