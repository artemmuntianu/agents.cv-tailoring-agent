"""The application-form prompt: what a plan may say, and the form/CV/facts blocks it sees.

Pure and separate from the node (`apps/worker/agent/application.py`) for the same reason as the tailoring
prompt: the wording is the contract the extension relies on - the ids are the only way to name a
field, `cover_letter`/`resume_file` never carry a value, and a fact the blocks do not state is
`skip` rather than a guess.
"""

from agent.cover import cv_digest
from utils import candidate as candidate_module

APPLICATION_PROMPT = """\
You fill in one job application form for one candidate, in the language the form is written in.

The rules below are the contract, not style advice:
- The form block lists every fillable control with a `data-cvt-id` (f1, f2, ...). Those ids are
  the ONLY way to refer to a field: never invent an id, never rename one, never return a CSS
  selector or an XPath.
- `action` is one of:
  * "answer"      - you write the text for this field (text, textarea, number, date, select).
  * "select"      - choose one of this control's own options: `value` must be the option's label
                    exactly as the form prints it (a select value, the label of the radio or
                    checkbox option that should be picked, or - for a `combobox` - the label its
                    list shows, which the extension then clicks).
  * "cover_letter" - the candidate's cover letter belongs here. Return **no** value: the board
                    already holds the letter and the extension pastes it in untouched.
  * "resume_file" - the candidate's tailored CV document belongs here. Return **no** value: the
                    extension attaches the generated PDF. Exactly one field can be the resume:
                    when two upload controls carry the same label, the form's own ids and the
                    section headings in the html block say which of them is the CV.
  * "skip"        - leave this field to the candidate; `reason` says why in a few words.
- A field whose kind is `combobox` is a JavaScript dropdown (react-select and friends) rather than a
  text input, so it is always a "select" and never an "answer": name the option's label, and the
  extension opens the widget, finds that label and clicks it. Use "skip" with reason "dropdown" only
  when no fact gives you such a label - never name an option the list may not contain.
- Use ONLY facts stated in the vacancy, the candidate block or the CV block. If a question needs a
  fact that is not there, return "skip" with reason "no fact for this" - never invent an employer,
  a technology, a number, a date or a language level.
- Answer the question the field asks: for a yes/no group ("Так"/"Ні", "Yes"/"No") decide from the
  facts and pick that option - do not default to the first one.
- The candidate facts are stored in English while the form may be in any language: answer in the
  form's OWN language and translate the fact faithfully (a Ukrainian form gets a Ukrainian
  answer), never paste an English sentence into a form written in another language.
- Always leave consent, terms and privacy checkboxes and "save as template"-style controls to the
  candidate: "skip" with reason "consent" or "site preference".
- A field the form pre-fills itself (a salary the site already holds, a CV it already selected) is
  "skip" unless a candidate fact contradicts it, and then say so in `note`. A field marked
  `hidden` is usually that kind - but a hidden *file* field is the upload control behind a styled
  dropzone, and that one is where the tailored document belongs.
- Keep every answer short and concrete: two sentences at most, plain text, no markdown, no bullet
  characters, no placeholders such as [Company]. A yes/no answer is one word.
- Mention in `note` anything the candidate must check by hand (a required field you skipped, a
  fact you were missing). Leave it empty when the plan is complete.
- Answer with JSON matching the schema: {"fields": [...], "note": "..."} - one entry per field you
  can decide, in the order the fields appear in the form.
"""


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
