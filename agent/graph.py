from langgraph.graph import StateGraph, END
from agent.state import State
import config
from agent.nodes import adapt_text, render, vision_check

def should_continue(state: State) -> str:
    if state.get("is_approved", False) or state.get("revision_count", 0) >= config.MAX_REVISIONS:
        print(f"🏁 Graph completed. Approved: {state.get('is_approved')}, Revision count: {state.get('revision_count')}/{config.MAX_REVISIONS}")
        return END
    print("🔄 Visual issues found. Retrying text adaptation with conciseness feedback...")
    return "adapt_text"

def create_graph():
    workflow = StateGraph(State)
    
    workflow.add_node("adapt_text", adapt_text)
    workflow.add_node("render", render)
    workflow.add_node("vision_check", vision_check)
    
    workflow.set_entry_point("adapt_text")
    workflow.add_edge("adapt_text", "render")
    workflow.add_edge("render", "vision_check")
    
    workflow.add_conditional_edges(
        "vision_check",
        should_continue,
        {
            END: END,
            "adapt_text": "adapt_text"
        }
    )
    
    return workflow.compile()
