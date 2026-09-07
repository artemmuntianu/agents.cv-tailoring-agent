from typing import List
from pydantic import BaseModel, Field

class TextReplacement(BaseModel):
    original_text: str = Field(description="Exact snippet of original text to be replaced.")
    tailored_text: str = Field(description="Tailored text rephrased using Action + Context + Result formula.")

class TextModificationList(BaseModel):
    modifications: List[TextReplacement] = Field(description="List of original to tailored text replacement pairs.")

class LayoutCheckResult(BaseModel):
    is_layout_ok: bool = Field(description="True if formatting, layout, and line distribution are clean without overflow.")
    feedback: str = Field(description="Detailed visual feedback, specifically flagging orphaned/widow lines or page spillover.")
