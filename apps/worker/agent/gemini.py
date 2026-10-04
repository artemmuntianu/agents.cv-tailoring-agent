"""The only place a Gemini client is built, and the only three model calls.

The prompts live with their own layers (`apps/worker/agent/tailoring_prompt.py` + `apps/worker/agent/nodes.py`,
`apps/worker/agent/cover.py`, `apps/worker/agent/application.py`); this module owns the plumbing they share: the client,
the Pydantic `response_schema`, the quota-aware backoff decorator, and the 1-shot self-healing
retry for the times the model answers with the wrong JSON shape. `config.MODEL_NAME` is validated
against `models.list()` by the worker's preflight, so a placeholder id never reaches a task.
"""

from google import genai
from google.genai import types

import config
from agent.models import JobRoleExtraction, LayoutCheckResult, TextModificationList
from utils.logging_setup import get_logger
from utils.retry import retry_with_exponential_backoff

log = get_logger(__name__)


def _self_healing_generate(client, model_name, contents, response_schema, temperature=0.0):
    """Call Gemini with 1-shot self-healing schema retry on JSON/Pydantic validation failure."""
    try:
        response = client.models.generate_content(
            model=model_name,
            contents=contents,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=response_schema,
                temperature=temperature,
            ),
        )
        return response_schema.model_validate_json(response.text)
    except Exception as first_err:  # noqa: BLE001
        log.warning(
            "schema validation failed on first attempt; attempting 1-shot self-healing retry",
            error=str(first_err),
            schema=response_schema.__name__,
        )
        correction_prompt = (
            f"{contents}\n\nCRITICAL FIX REQUIRED: Your previous response failed JSON schema validation "
            f"for {response_schema.__name__} with error:\n{first_err}\n"
            "Please fix the output formatting and return a valid JSON object strictly matching the required schema."
        )
        response = client.models.generate_content(
            model=model_name,
            contents=correction_prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=response_schema,
                temperature=temperature,
            ),
        )
        return response_schema.model_validate_json(response.text)


@retry_with_exponential_backoff
def extract_role(client, job_description: str) -> str:
    prompt = f"""Extract the exact or primary target role title from this job description.
Return json matching schema with target_role_title.

JOB DESCRIPTION:
{job_description}"""
    res = _self_healing_generate(
        client, config.MODEL_NAME, prompt, JobRoleExtraction, temperature=0.0
    )
    return res.target_role_title.strip()


@retry_with_exponential_backoff
def suggest_replacements(client, prompt):
    return _self_healing_generate(
        client, config.MODEL_NAME, prompt, TextModificationList, temperature=0.2
    )


@retry_with_exponential_backoff
def evaluate_layout(client, contents):
    return _self_healing_generate(
        client, config.MODEL_NAME, contents, LayoutCheckResult, temperature=0.1
    )


def client():
    if getattr(config, "GEMINI_API_KEY", None):
        return genai.Client(api_key=config.GEMINI_API_KEY)
    return genai.Client()
