"""`vision_check`: the rendered pages judged for layout defects - its prompt lives here too.

The loop it feeds (`should_continue` in `agent/graph.py`) can only ask for shorter text, never for
a different design, which is why the guidelines explicitly accept multi-page output and the
document's own intentional overlaps, and only flag severe structural defects.
"""

from PIL import Image

from agent import gemini
from agent.contracts import JobStatus
from agent.job_log import job_logger, set_status
from agent.state import State
from utils.logging_setup import get_logger

log = get_logger(__name__)


def vision_check(state: State) -> State:
    job_log = job_logger(state)
    set_status(state, JobStatus.VALIDATING)
    job_log.info("node started", node="vision_check")
    client = gemini.client()

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
        result = gemini.evaluate_layout(client, [*images, prompt])
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
