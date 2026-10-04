# apps/worker/agent/ - LangGraph orchestration layer

The **business logic** of the tailoring flow: what a task is, how the graph runs,
what the LLM is asked to do, and how the result becomes a DOCX + PDF + DB row.

Read `CONSTITUTION.md` first; this file is the layer-specific detail.

## Files

| File | Owns |
|---|---|
| `state.py` | `State` (flat `TypedDict`) + `initial_state()`, which fills every key |
| `contracts.py` | `ResumeTaskMessage`, `CvData`/`CvHeader`/`CvExperience`/`CvProject`, `JobStatus`, `TaskResult` |
| `models.py` | Pydantic schemas used as Gemini `response_schema` (`JobRoleExtraction`, `TextModificationList`, `LayoutCheckResult`); field validators strip leading bullet markers and enforce the single-line invariant before objects reach the AST mutator |
| `job_log.py` | The per-run log/status context: `job_logger(state)` (the bound `job_id`/`external_id`/`attempt` fields) and `set_status()` - a status write is never fatal |
| `gemini.py` | The plumbing: `client()`, `extract_role()`, `suggest_replacements()`, `evaluate_layout()`, plus `_self_healing_generate` (1-shot schema retry). The only module that builds a client |
| `tailoring_prompt.py` | The tailoring rules and `build_tailoring_prompt()` - pure, keyword-only, the wording itself |
| `nodes.py` | `adapt_text` (sync-check, candidate facts, replacements, read-only drop) and `render` (LibreOffice) |
| `vision.py` | `vision_check` and its layout prompt |
| `document_gate.py` | `verify_document`: the last line of defence - reads the produced DOCX back (`read_docx_text`) and fails the task (`ValueError`, nothing uploaded) when the file claims a technology or a metric that nothing backs (invariant 33). It runs **facts before pixels**, straight after `adapt_text` and before `render`, so a lying document never reaches the renderer and the vision retry loop never runs on one |
| `persist.py` | The terminal node: upload the artifacts, write the row's durability fields |
| `verification.py` | Deterministic 0%-lies check, and the loop that reacts to it: `invented_technologies()` finds every technology claim in a text that neither the master CV text nor the candidate facts state - detection is a curated vocabulary *plus* the shape of a name (internal capital, digit), and the **job description is never evidence** (invariant 33). `evaluate_fabrications()` grades a whole answer, `self_heal_replacements()` gives a violating answer back to the model with the violations spelled out up to `MAX_FABRICATION_RETRIES` (3) times keeping the best draft, and `scan_document_for_fabrications()` runs the same rule over the produced file |
| `cover.py` | The cover-letter prompt, its `response_schema` and `run_cover_letter()` - the one Gemini call the board triggers by hand |
| `application_prompt.py` | The form prompt and `build_prompt()` - the four blocks it sees (vacancy, candidate facts, CV digest, the annotated form) |
| `application.py` | `ApplicationPlan`, `normalize_plan()` and the one Gemini call the extension's *Populate* triggers. It answers with the ids the extension minted, never returns a selector, never carries the generated documents, and drops an id the snapshot does not contain |
| `graph.py` | Graph topology, `check_after_adapt`, `should_continue`, `create_graph()` |
| `pipeline.py` | `run_cv_tailoring()` / `run_task()` - the only entry into the graph |
| `__init__.py` | Package marker |

## Graph

```
adapt_text --(applied > 0)--> render --> vision_check --(approved | revisions >= MAX)--> persist --> END
    |                                        |
    +--(applied == 0)--> persist             +--> adapt_text   (revise with layout feedback)
```

- `check_after_adapt` short-circuits to `persist` when nothing matched in the DOCX.
- `should_continue` loops back to `adapt_text` with `layout_feedback` until approved
  or `config.MAX_REVISIONS` is reached.
- `persist` is the **mandatory terminal node** - the queue message is only acked
  after it returns (see `CONSTITUTION.md` invariant 2).

## Node contract

Each node receives the full `State` and returns a **new dict** (`{**state, ...}`) -
never mutate in place.

| Node | Does | Writes |
|---|---|---|
| `adapt_text` | sync-checks `cv_data` vs `cv.docx`, loads the candidate facts, extracts the target role, asks Gemini for replacements, drops any that target the read-only projects block, applies the rest to the DOCX | `target_role_title`, `current_cv_text`, `modifications`, `revision_count`; `is_approved=True` + `status_hint=skipped` when nothing applied |
| `render` | DOCX -> PDF -> page PNGs in `temp_dir` (per-job LibreOffice profile) | `image_paths`, `pdf_path` |
| `vision_check` | sends the page images to Gemini with the layout prompt | `is_approved`, `layout_feedback` |
| `persist` | uploads PDF + DOCX, computes `duration_ms`, writes the final row | `pdf_url`, `docx_url`, `status_hint` |

`_set_status()` writes a status transition (`JobStatus.*`) and is **never fatal** -
a DB hiccup must not kill a task that is otherwise progressing.

## Contract rules (do not break)

- `ResumeTaskMessage.job_id` is opaque, 4-80 chars of `[A-Za-z0-9_.:-]` (anchored
  in Pydantic); defaulted to a UUID when omitted. It is a **row id**, not a business key.
- Business identity is `(user_id, external_id, cv_version)`; `key()` builds the
  idempotency string used by the DB.
- `extra="allow"` on the pydantic models: publishers may add fields without
  breaking the worker.

## Prompt invariants

The adaptation prompt is part of the product, not a comment - it lives in
`apps/worker/agent/tailoring_prompt.py` (`build_tailoring_prompt()`, pure and keyword-only). Keep all of these:

1. **Single line per replacement.** `original_text` and `tailored_text` must each be
   exactly one line - a SKILLS label and its value are two separate paragraphs and
   therefore two separate entries. `normalize_replacements()` repairs violations
   and drops what it cannot align, but the prompt must not rely on that.
2. **No bullet markers** (`-`, `*`, `o`, `-`, `-`) at the start of either string;
   Word renders the list bullet itself, so a leading marker produces a double bullet.
3. **Verbatim `original_text`**, copied from the CV text dump.
4. **No fabrication**: never invent employers, titles, dates, technologies or
   metrics; never change a real figure.
5. **Keep count and order** of experience entries and bullets; keep replacements
   roughly the same length as the original.
6. **PERSONAL PROJECTS is read-only context.** The model sees the block and may back
   a SUMMARY or SKILLS claim with it, but it must never return one of its lines as
   `original_text`: `drop_read_only_replacements()` enforces exactly that, so the
   prompt rule and the code state the same thing.
7. **The candidate facts are evidence, not document text.** The prompt carries the
   `application_profile` digest as ground truth (a fact-backed technology or number
   is admissible, see `apps/worker/agent/verification.py::evaluate_fabrications(ground_truth=...)`)
   and forbids writing salary, availability, work format, location, contacts or
   job-search status anywhere in the CV.

## Adding or changing a node

1. Add the key(s) to `State` **and** to `initial_state()` (nodes may read without
   `KeyError`).
2. Implement the node in its own module (`nodes.py` for the adaptation stage, `vision.py` /
   `persist.py` for the post-render ones) returning `{**state, ...}`.
3. Register it in `graph.create_graph()` and wire the edges (use a conditional-edge
   function for branching, like `should_continue`).
4. If it calls Gemini, decorate with `@retry_with_exponential_backoff` and pass a
   `response_schema` from `apps/worker/agent/models.py`.
5. Cover it through `apps/worker/tests/helpers.fake_gemini` (see `apps/worker/tests/AGENTS.md`).

## Testing this layer

- `apps/worker/tests/helpers.isolated_config()` points every path/backend at a temp dir.
- `apps/worker/tests/helpers.fake_gemini(replacements, layout_ok=..., calls=...)` replaces all
  three Gemini calls **and** both render tools, so no network or LibreOffice is needed.
- `apps/worker/tests/test_worker_pipeline.py` exercises the whole graph end-to-end.

## Don't

- Call Gemini anywhere except `apps/worker/agent/gemini.py` (the plumbing) and the module whose prompt owns
  the call (`apps/worker/agent/tailoring_prompt.py` + `nodes.py`, `apps/worker/agent/cover.py`, `apps/worker/agent/application.py`),
  and only through the decorated helpers.
- Bypass `pipeline.run_cv_tailoring()` / `run_task()` from a new entry point.
- Cache the CV model in a module-level global (this caused a cross-task staleness
  bug; `cv_data` is always an explicit argument).
- Import anything from `worker.py` (the entry point depends on this layer, never the
  other way round).
