/*
  One-off: move the scheduled intake's cards onto the operator's account, and drop the scout's
  placeholder candidate-facts row.

  Why this exists: every prompt - the CV tailoring, the cover letter and the application form - is
  grounded in the candidate facts of the **card's owner** (`candidate_module.load(store,
  row.user_id)`: `agent/nodes.py`, `agent/document_gate.py`, `cover.py`, `apply.py`). The scheduled
  intake filed its cards under `SCOUT_USER_ID` - a separate service account (`scout@local`) - whose
  `application_profile` row held placeholder values (`location = 'Ukraine (remote)'`, ...). The
  board's `/sources` page renders the *signed-in operator's* row instead, so the operator saw
  `Portugal` on `/sources` while every scouted card's form was drafted from the scout's `Ukraine`
  facts (reported 2026-10-03 on Djinni 851326).

  The board never reads the owner - `CARD_SELECT` does not select `user_id`, `fetchBoard` does not
  filter by it, and both dedupe callers (`/api/vacancies/batch`, `/api/vacancies/status`) already
  pass `scope: 'board'` - so the two-account split bought nothing but the wrong facts (the
  "a scouted card is visibly not yours" intent in `deploy/values/dev.yaml` was never implemented).
  Fix: the intake files under the operator, so `resumes.user_id` is half of the business key of the
  *one* facts row that grounds everything.

  The rule, in order:

    * delete `scout@local`'s `application_profile` row - the placeholder facts, and the only reason
      the wrong answer could be produced at all. A card owned by that account now yields an empty
      CANDIDATE block and the model `skip`s what it cannot answer instead of inventing it;
    * a vacancy the operator **already owns** would collide with `resumes_job_key_idx`
      (`coalesce(user_id,'local'), source, external_id, cv_version`), so the scout's duplicate row is
      removed instead of re-owned - its child rows (`resume_board`, `resume_history`,
      `resume_application`, `resume_cover_letter`, `resume_interview`, `resume_docx_update`) all hang
      off `job_id` `on delete cascade`. Verified 0 such conflicts on 2026-10-03;
    * the rest are re-owned in place. `resume_history.actor` is `Candidate`/`Company`, not the
      account, so the audit trail stays truthful and no history row is rewritten;
    * the application drafts those cards already hold are **deleted**: they were produced from the
      scout's facts, and the plan's cache key - the rendered form plus the *operator's* facts
      version (`lib/application.ts::schemaHash`) - is unchanged by this repair, so a stale plan
      would otherwise be served again by the next *Populate*. The extension then re-drafts (one
      Gemini call) instead of failing.

  After this, future runs must also file under the operator: `cv-tailoring-scout.config.userId`
  (`deploy/values/dev.yaml`) is `u-03ac63cd26651373`, NOT `scout@local`.

  Idempotent: a second run finds no `scout@local` rows and updates nothing. It touches only
  `application_profile` and `resumes.user_id` - no `status`, no board stage, no history (invariants
  19, 27).

  Run it (from the repo root, against the cluster's Postgres):

      kubectl exec -i deploy/postgres -- psql -U cvt -d cvt -v ON_ERROR_STOP=1 < scripts/reown_scout_cards.sql

  or, from the host through a port-forward (PowerShell needs the value set explicitly - an empty
  `DATABASE_SSLMODE` is *deleted* by the shell, root AGENTS.md trap 18):

      $env:DB_BACKEND="postgres"; $env:DATABASE_URL="postgresql://cvt:cvt@localhost:5432/cvt"
      $env:DATABASE_SSLMODE="disable"
      python -c "import psycopg,pathlib; c=psycopg.connect('postgresql://cvt:cvt@localhost:5432/cvt'); c.cursor().execute(pathlib.Path('scripts/reown_scout_cards.sql').read_text(encoding='utf-8')); c.commit()"

  It is a **one-off data repair**, not a migration: nothing in the runtime depends on it, and the
  file stays in `scripts/` as the written record of what it changed (scripts/AGENTS.md).
*/

begin;

-- The scout's cards, captured before anything moves: step 4 needs the ids the re-own itself erases.
create temp table scout_cards on commit drop as
    select job_id from resumes where user_id = 'u-53f18341fb2495b8';

-- Who is about to move, and where to. Read this before the update; the same ids drive it.
select user_id, count(*) as cards
  from resumes
 where user_id = 'u-53f18341fb2495b8'
 group by user_id;

-- 1. The scout's placeholder facts: the row that produced the wrong answers.
delete from application_profile where user_id = 'u-53f18341fb2495b8';

-- 2. The scout's duplicate of a vacancy the operator already owns: drop the scout row (and its
--    board/child rows) rather than collide with the unique business key.
delete from resumes r
 where r.user_id = 'u-53f18341fb2495b8'
   and exists (
       select 1 from resumes o
        where o.user_id = 'u-03ac63cd26651373'
          and o.source = r.source
          and o.external_id = r.external_id
          and o.cv_version = r.cv_version
   );

-- 3. Re-own the rest: the operator's row is the one every prompt reads.
update resumes
   set user_id = 'u-03ac63cd26651373'
 where user_id = 'u-53f18341fb2495b8';

-- 4. Drop the application drafts those cards already hold. They were produced from the *scout's*
--    facts, and the plan's cache key - the rendered form plus the OPERATOR's facts version
--    (`lib/application.ts::schemaHash`) - did not change, so without this step the next *Populate*
--    would be served the stale answer: exactly the "Ukraine" this repair is about. Removing the row
--    makes the extension re-draft (one Gemini call) instead of showing a failure.
delete from resume_application where job_id in (select job_id from scout_cards);

-- Confirmation: the scout owns nothing any more, and no draft it grounded survives.
select user_id, count(*) as cards
  from resumes
 where user_id in ('u-53f18341fb2495b8', 'u-03ac63cd26651373')
 group by user_id
 order by user_id;

select count(*) as stale_plans_left
  from resume_application
 where job_id in (select job_id from scout_cards);

commit;
