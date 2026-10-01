"""LangGraph topology.

    adapt_text ──► render ──► vision_check ──┬──► verify_document ──► persist ──► END
         ▲                                   │
         └─────────── retry (max N) ─────────┘

`verify_document` reads the produced DOCX back and fails the task if it claims anything the CV
text and the candidate facts do not back (`agent/document_gate.py`), so nothing unbacked can reach
`persist`. `persist` is the mandatory terminal node: it uploads the PDF/DOCX and writes the final
status, so a graph run only completes once the artifact is durable. The queue message stays unacked
until then.
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


def check_after_adapt(state: State) -> str:
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
    workflow.add_node("render", render)
    workflow.add_node("vision_check", vision_check)
    workflow.add_node("verify_document", verify_document)
    workflow.add_node("persist", persist)

    workflow.set_entry_point("adapt_text")

    workflow.add_conditional_edges(
        "adapt_text",
        check_after_adapt,
        {
            # Even the early stop goes through the gate: "no replacements applied" still means a
            # document is about to be uploaded.
            "persist": "verify_document",
            "render": "render",
        },
    )

    workflow.add_edge("render", "vision_check")

    workflow.add_conditional_edges(
        "vision_check",
        should_continue,
        {
            "persist": "verify_document",
            "adapt_text": "adapt_text",
        },
    )

    workflow.add_edge("verify_document", "persist")
    workflow.add_edge("persist", END)

    return workflow.compile()
