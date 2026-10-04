from pydantic import BaseModel, Field, field_validator


def _clean_single_line(value: str) -> str:
    """Sanitize string to enforce single-line invariant and strip bullet markers."""
    if not value:
        return ""
    # Strip newline / carriage return characters
    clean = value.replace("\r\n", " ").replace("\n", " ").replace("\r", " ").strip()
    # Strip leading bullet / list marker characters
    for prefix in ("• ", "- ", "* ", "o ", "– ", "— ", "•", "-", "*", "–", "—"):
        if clean.startswith(prefix):
            clean = clean[len(prefix):].strip()
            break
    return clean


class JobRoleExtraction(BaseModel):
    target_role_title: str = Field(
        description="The primary target role title extracted from the job description."
    )

    @field_validator("target_role_title")
    @classmethod
    def sanitize_title(cls, v: str) -> str:
        return _clean_single_line(v)


class TextReplacement(BaseModel):
    original_text: str = Field(
        description="Exact snippet of original text to be replaced."
    )
    tailored_text: str = Field(
        description="Tailored text rephrased using Action + Context + Result formula."
    )
    reason: str = Field(
        description="Explanation of why this replacement was made to align with the target job requirements."
    )

    @field_validator("original_text", "tailored_text")
    @classmethod
    def sanitize_replacement_text(cls, v: str) -> str:
        return _clean_single_line(v)


class TextModificationList(BaseModel):
    modifications: list[TextReplacement] = Field(
        description="List of original to tailored text replacement pairs."
    )


class LayoutCheckResult(BaseModel):
    is_layout_ok: bool = Field(
        description="True if formatting, layout, and line distribution are clean without overflow."
    )
    feedback: str = Field(
        description="Detailed visual feedback, specifically flagging orphaned/widow lines or page spillover."
    )
