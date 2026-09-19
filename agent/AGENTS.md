# agent/ - LangGraph orchestration layer

The **business logic** of the tailoring flow: what a task is, how the graph runs,
what the LLM is asked to do, and how the result becomes a DOCX + PDF + DB row.

Read `CONSTITUTION.md` first; this file is the layer-specific detail.

## Files

| File | Owns |
|---|---|
| `state.py` | `State` (flat `TypedDict`) + `initial_state()`, which fills every key |
| `contracts.py` | `ResumeTaskMessage`, `CvData`/`CvHeader`/`CvExperience`, `JobStatus`, `TaskResult` |
| `models.py` | Pydantic schemas used as Gemini `response_schema` (`JobRoleExtraction`, `TextModificationList`, `LayoutCheckResult`) |
| `nodes.py` | The four nodes + the three `_call_gemini_*` functions + the prompt |
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
| `adapt_text` | sync-checks `cv_data` vs `cv.docx`, extracts the target role, asks Gemini for replacements, normalises them, applies them to the DOCX | `target_role_title`, `current_cv_text`, `modifications`, `revision_count`; `is_approved=True` + `status_hint=skipped` when nothing applied |
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

The adaptation prompt is part of the product, not a comment. Keep all of these:

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

## Adding or changing a node

1. Add the key(s) to `State` **and** to `initial_state()` (nodes may read without
   `KeyError`).
2. Implement the node in `nodes.py` returning `{**state, ...}`.
3. Register it in `graph.create_graph()` and wire the edges (use a conditional-edge
   function for branching, like `should_continue`).
4. If it calls Gemini, decorate with `@retry_with_exponential_backoff` and pass a
   `response_schema` from `agent/models.py`.
5. Cover it through `tests/helpers.fake_gemini` (see `tests/AGENTS.md`).

## Testing this layer

- `tests/helpers.isolated_config()` points every path/backend at a temp dir.
- `tests/helpers.fake_gemini(replacements, layout_ok=..., calls=...)` replaces all
  three Gemini calls **and** both render tools, so no network or LibreOffice is needed.
- `tests/test_worker_pipeline.py` exercises the whole graph end-to-end.

## Don't

- Call Gemini anywhere except `nodes.py`, and only through the decorated helpers.
- Bypass `pipeline.run_cv_tailoring()` / `run_task()` from a new entry point.
- Cache the CV model in a module-level global (this caused a cross-task staleness
  bug; `cv_data` is always an explicit argument).
- Import anything from `worker.py` / `main.py` (entry points depend on this layer,
  never the other way round).
