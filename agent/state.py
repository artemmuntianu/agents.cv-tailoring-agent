from typing import List, Dict, TypedDict

class State(TypedDict):
    cv_path: str
    job_description: str
    output_path: str
    current_cv_text: str
    modifications: List[Dict[str, str]]
    layout_feedback: str
    revision_count: int
    image_paths: List[str]
    is_approved: bool
