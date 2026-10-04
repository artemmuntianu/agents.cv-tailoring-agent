"""Application-form drafting - the plan the extension applies to a rendered form.

`apps/worker/agent/tailoring_prompt.py` + `apps/worker/agent/nodes.py` own the tailoring prompt, `apps/worker/agent/cover.py` the
letter prompt; the *form* prompt is in `apps/worker/agent/application_prompt.py` and this module owns what
happens around it: the two response models, the `normalize_plan()` contract check (an id the
snapshot does not contain is dropped, an unknown action is a dead letter) and the one Gemini call
the extension's *Populate* triggers.

Every fact comes from the vacancy, the candidate profile (`application_profile`, one row per
operator) and the CV digest; anything they do not answer is `skip`, never a guess - a wrong
sentence on a real application is worse than a blank field (the same rule invariant 7 states for
the CV). Like the other two paths this goes through `utils.retry.retry_with_exponential_backoff`
and asks for a Pydantic `response_schema`, so nothing here parses free text.
"""

from google.genai import types
from pydantic import BaseModel, Field

import config
from agent import gemini
from agent.application_prompt import build_prompt
from utils.logging_setup import get_logger
from utils.retry import retry_with_exponential_backoff

log = get_logger(__name__)

# The five things a plan may tell the extension to do. Validated here rather than in the response
# schema: `Literal`/enum conversion is the flakiest part of a structured response, and a broken
# contract should be a clear dead-letter, not a 400 from the model.
ACTIONS = ("answer", "select", "cover_letter", "resume_file", "skip")

# A field's answer is a couple of sentences; anything longer is the model padding (or quoting the
# vacancy back), and the extension would paste junk into a form.
MAX_ANSWER_CHARS = 4000


class FieldAnswer(BaseModel):
    """One field's decision: what to do with it, and (for `answer`/`select`) what to put in it."""

    id: str = Field(description="The control's data-cvt-id from the form block, e.g. f3.")
    action: str = Field(description="answer | select | cover_letter | resume_file | skip")
    value: str = Field(default="", description="The text or option label; empty for the rest.")
    reason: str = Field(default="", description="Why the field was skipped, in a few words.")


class ApplicationPlan(BaseModel):
    """The only response shape: one decision per field plus what the candidate should know."""

    fields: list[FieldAnswer] = Field(default_factory=list)
    note: str = Field(default="", description="Anything the candidate must check by hand.")


@retry_with_exponential_backoff
def _call_gemini_application(client, prompt: str) -> ApplicationPlan:
    response = client.models.generate_content(
        model=config.MODEL_NAME,
        contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=ApplicationPlan,
            # Cooler than the letter: this is a mapping job, and the facts are pinned by the
            # prompt. A little warmth only makes the answers read like a person wrote them.
            temperature=0.3,
        ),
    )
    return ApplicationPlan.model_validate_json(response.text)


def normalize_plan(plan: ApplicationPlan, form) -> dict:
    """Validate the model's answer against the snapshot and return the storable plan.

    Three rules, all of them about not trusting a language model with a live DOM:

    * an id that is not in the snapshot is dropped (the model cannot introduce a field);
    * an action outside `ACTIONS` is a broken contract - a `ValueError`, i.e. a dead letter;
    * `cover_letter`/`resume_file` never carry a value: the extension inserts those locally, so a
      value here would be a document the model made up.

    The stored plan keeps `kind`/`label` per field (the review panel and the applier read them) and
    lists the fields the model left undecided, so "nothing was pasted there" is visible.
    """
    known = {field.id: field for field in form.fields}
    normalized: list[dict] = []
    seen: set[str] = set()

    for answer in plan.fields:
        field_id = str(answer.id or "").strip()
        if field_id not in known:
            log.warning(
                "the plan names a field that is not in the form - dropping it", field=field_id
            )
            continue
        if field_id in seen:
            continue
        action = str(answer.action or "").strip().lower()
        if action not in ACTIONS:
            raise ValueError(f"unknown action {action!r} for field {field_id}")

        value = str(answer.value or "").strip()
        reason = str(answer.reason or "").strip()[:500]
        if action in ("cover_letter", "resume_file"):
            value = ""
        elif action in ("answer", "select") and not value:
            # Nothing to paste: report it as a skip rather than an empty instruction.
            action, reason = "skip", reason or "the model returned no value"
        if len(value) > MAX_ANSWER_CHARS:
            log.warning("truncating an oversized answer", field=field_id, chars=len(value))
            value = value[:MAX_ANSWER_CHARS]

        seen.add(field_id)
        normalized.append(
            {
                "id": field_id,
                "action": action,
                "value": value,
                "reason": reason,
                "kind": known[field_id].kind,
                "label": known[field_id].label,
            }
        )

    # Feed order, so the stored plan reads like the form even when the model answered out of order.
    order = {field_id: index for index, field_id in enumerate(known)}
    normalized.sort(key=lambda item: order.get(item["id"], len(order)))
    return {
        "fields": normalized,
        "note": str(plan.note or "").strip()[:1000],
        "undecided": [field_id for field_id in known if field_id not in seen],
    }


def run_application_draft(
    job_id, description_raw, candidate=None, form=None, cv_data=None, title="", company=""
) -> dict:
    """Draft one application form.

    Raises `ValueError` when there is nothing to work from (a broken row, an empty form) or when
    the model breaks the contract, and `RetryLater` when the Gemini quota is out - the caller turns
    that into a delayed redelivery, exactly like the cover-letter worker does.
    """
    if not (description_raw or "").strip():
        raise ValueError("this vacancy has no stored job description")
    if form is None or not form.fields:
        raise ValueError("the form snapshot carries no fillable fields")

    prompt = build_prompt(description_raw, cv_data, candidate, form, title=title, company=company)
    client = gemini.client()
    log.info(
        "drafting an application form",
        job_id=job_id,
        model=config.MODEL_NAME,
        fields=len(form.fields),
    )
    plan = normalize_plan(_call_gemini_application(client, prompt), form)
    if not plan["fields"]:
        raise ValueError("the model returned no decision for any field in the form")
    return plan
