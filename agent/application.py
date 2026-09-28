"""Application-form drafting - the plan the extension applies to a rendered form.

`agent/nodes.py` owns the tailoring prompt, `agent/cover.py` the letter prompt; this module owns
the third one, and the job it describes is deliberately different:

* the form arrives as a snapshot the **extension annotated itself** (`data-cvt-id="f1"`, ...), so
  the model answers with *those* ids and never has to invent a CSS selector or an XPath - the
  extension resolves each id back to the element it annotated (`extension/src/form/`);
* the model never receives the generated documents. It answers two things: what to write in the
  *question* fields, and which field is the **message** and which is the **resume** - the
  extension inserts the already-generated cover letter and tailored PDF locally, from the board.
  That is why `cover_letter`/`resume_file` carry no value at all;
* every fact comes from the vacancy, the candidate profile (`candidate_profile.json`) and the CV
  digest. Anything the facts do not answer is `skip`, never a guess - a wrong sentence on a real
  application is worse than a blank field (the same rule invariant 7 states for the CV).

Like the other two paths this goes through `utils.retry.retry_with_exponential_backoff` and asks
for a Pydantic `response_schema`, so nothing here parses free text.
"""

from google.genai import types
from pydantic import BaseModel, Field

import config
from agent.cover import cv_digest
from agent.nodes import get_genai_client
from utils import candidate as candidate_module
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

APPLICATION_PROMPT = """\
You fill in one job application form for one candidate, in the language the form is written in.

The rules below are the contract, not style advice:
- The form block lists every fillable control with a `data-cvt-id` (f1, f2, ...). Those ids are
  the ONLY way to refer to a field: never invent an id, never rename one, never return a CSS
  selector or an XPath.
- `action` is one of:
  * "answer"      - you write the text for this field (text, textarea, number, date, select).
  * "select"      - choose one of this control's own options: `value` must be the option's label
                    exactly as the form prints it (a select value, or the label of the radio or
                    checkbox option that should be picked).
  * "cover_letter" - the candidate's cover letter belongs here. Return **no** value: the board
                    already holds the letter and the extension pastes it in untouched.
  * "resume_file" - the candidate's tailored CV document belongs here. Return **no** value: the
                    extension attaches the generated PDF.
  * "skip"        - leave this field to the candidate; `reason` says why in a few words.
- Use ONLY facts stated in the vacancy, the candidate block or the CV block. If a question needs a
  fact that is not there, return "skip" with reason "no fact for this" - never invent an employer,
  a technology, a number, a date or a language level.
- Answer the question the field asks: for a yes/no group ("Так"/"Ні", "Yes"/"No") decide from the
  facts and pick that option - do not default to the first one.
- Always leave consent, terms and privacy checkboxes and "save as template"-style controls to the
  candidate: "skip" with reason "consent" or "site preference".
- A field the form pre-fills itself (a salary the site already holds, a CV it already selected) is
  "skip" unless a candidate fact contradicts it, and then say so in `note`.
- Keep every answer short and concrete: two sentences at most, plain text, no markdown, no bullet
  characters, no placeholders such as [Company]. A yes/no answer is one word.
- Mention in `note` anything the candidate must check by hand (a required field you skipped, a
  fact you were missing). Leave it empty when the plan is complete.
- Answer with JSON matching the schema: {"fields": [...], "note": "..."} - one entry per field you
  can decide, in the order the fields appear in the form.
"""


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


def _one_line(text: str) -> str:
    """A label read from the DOM can carry newlines; the field list stays one line per field."""
    return " ".join(str(text or "").split())[:300]


def form_block(form) -> str:
    """The form as the model sees it: the authoritative field list, then the annotated DOM.

    The list comes first on purpose - it is what the plan is keyed on - and the DOM follows as
    context (the section headings, which question belongs to which control, the option labels).
    """
    lines: list[str] = []
    for field in form.fields:
        parts = [f"{field.id}: {field.kind}"]
        if field.required:
            parts.append("required")
        if field.name:
            parts.append(f"name={field.name}")
        if field.label:
            parts.append(f"label={_one_line(field.label)}")
        if field.placeholder:
            parts.append(f"placeholder={_one_line(field.placeholder)}")
        if field.hidden:
            # The site pre-fills it and keeps it out of sight (Djinni's salary input): the model
            # should say "skip" rather than write into something nobody is looking at.
            parts.append("hidden")
        if field.options:
            parts.append("options=[" + " | ".join(field.options) + "]")
        lines.append("- " + " ".join(parts))
    return "\n".join(
        [
            f"root: {form.root or '(unknown)'}",
            "fields:",
            "\n".join(lines) or "(none detected)",
            "html:",
            form.html.strip(),
        ]
    )


def build_prompt(
    description_raw, cv_data=None, candidate=None, form=None, title="", company=""
) -> str:
    """Assemble the prompt. Pure, so the exact wording is reviewable and cheap to change."""
    vacancy = "\n".join(
        line for line in [f"TITLE: {title}".strip(), f"COMPANY: {company}".strip()] if line
    )
    return "\n".join(
        [
            APPLICATION_PROMPT,
            "-------------------- VACANCY --------------------",
            vacancy,
            (description_raw or "").strip(),
            "-------------------- CANDIDATE --------------------",
            candidate_module.digest(candidate) or "(no candidate profile available)",
            "-------------------- CV --------------------",
            cv_digest(cv_data) or "(no CV model available)",
            "-------------------- FORM --------------------",
            form_block(form) if form is not None else "(no form snapshot)",
        ]
    ).strip()


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
    client = get_genai_client()
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
