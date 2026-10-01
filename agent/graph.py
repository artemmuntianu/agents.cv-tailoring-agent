"""LangGraph topology.

    adapt_text ──► verify_document ──┬──► render ──► vision_check ──┬──► persist ──► END
                                     │                              │
                                     └── (nothing applied) ─────────┴── retry (max N) ──► adapt_text

The order is deliberate: **facts before pixels**. `verify_document` reads the DOCX the model's
replacements just produced and fails the task if it claims anything the CV text and the candidate
facts do not back (`agent/document_gate.py`), so a lying document never reaches the renderer - the
expensive step - and the vision retry loop never runs on one either. Every pass through
`adapt_text` re-verifies, because the retry edge comes back through the gate.

`persist` is the mandatory terminal node: it uploads the PDF/DOCX and writes the final status, so a
graph run only completes once the artifact is durable. The queue message stays unacked until then.
"""

from langgraph.graph import END, StateGraph

import config
from agent.document_gate import verify_document
from agent.nodes import adapt_text, render
from agent.persist import persist
from agent.state import State
from agent.vision import vision_check
from utils.logging_setup import get_logger

log = get_logger(__name__)


def check_after_verify(state: State) -> str:
    """After the gate: skip the render entirely when there was nothing to apply.

    `adapt_text` sets `is_approved` when no replacement could be written to the document, and
    rendering an untouched CV would only cost a LibreOffice run. The gate still ran - that is the
    point of it sitting here rather than next to `persist`.
    """
    if state.get("is_approved", False):
        log.info("stopping graph early: no text replacements applied to docx")
        return "persist"
    return "render"


def should_continue(state: State) -> str:
    approved = state.get("is_approved", False)
    revisions = state.get("revision_count", 0)
    if approved or revisions >= config.MAX_REVISIONS:
        log.info(
            "graph producing final result",
            approved=approved,
            revisions=revisions,
            max_revisions=config.MAX_REVISIONS,
        )
        return "persist"
    log.info("visual issues found - retrying text adaptation with feedback")
    return "adapt_text"


def create_graph():
    workflow = StateGraph(State)

    workflow.add_node("adapt_text", adapt_text)
    workflow.add_node("verify_document", verify_document)
    workflow.add_node("render", render)
    workflow.add_node("vision_check", vision_check)
    workflow.add_node("persist", persist)

    workflow.set_entry_point("adapt_text")

    # Facts before pixels: the document the replacements just wrote is judged *before* it is
    # rendered. A lying CV fails here, so the renderer and the vision model never see it.
    workflow.add_edge("adapt_text", "verify_document")

    workflow.add_conditional_edges(
        "verify_document",
        check_after_verify,
        {
            "persist": "persist",
            "render": "render",
        },
    )

    workflow.add_edge("render", "vision_check")

    workflow.add_conditional_edges(
        "vision_check",
        should_continue,
        {
            # Straight to persist: this revision of the document already passed the gate above -
            # rendering and judging the pages does not change a word of its text.
            "persist": "persist",
            "adapt_text": "adapt_text",
        },
    )

    workflow.add_edge("persist", END)

    return workflow.compile()
