"""LangGraph topology.

    adapt_text ──► render ──► vision_check ──┬──► persist ──► END
         ▲                                   │
         └─────────── retry (max N) ─────────┘

`persist` is the mandatory terminal node: it uploads the PDF/DOCX and writes the
final status, so a graph run only completes once the artifact is durable. The
queue message stays unacked until then.
"""

from langgraph.graph import END, StateGraph

import config
from agent.nodes import adapt_text, persist, render, vision_check
from agent.state import State
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
    workflow.add_node("persist", persist)

    workflow.set_entry_point("adapt_text")

    workflow.add_conditional_edges(
        "adapt_text",
        check_after_adapt,
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
            "persist": "persist",
            "adapt_text": "adapt_text",
        },
    )

    workflow.add_edge("persist", END)

    return workflow.compile()
