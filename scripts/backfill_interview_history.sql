/*
  One-off: give the interviews that already exist the History line the Interviews section now
  writes (2026-10-01, `CONSTITUTION.md` invariant 26 as revised).

  Why this exists: `resume_interview` was deliberately the interview's only record, so the eight
  interviews created before 2026-10-01 have no `resume_history` line at all - and the operator's
  report that "adding an interview should be listed in History" was about exactly that. From now on
  `backoffice/src/lib/db.ts::insertInterview` writes the line itself (through
  `recordCardActivity`); this file catches up the rows that predate it.

  What it writes, per interview row: one `kind='move'` line, actor `Candidate`, action
  `Interview added: <type>, <YYYY-MM-DD HH:MM>`, `from_state = to_state` = the card's current
  column, and **`at` = the interview's own `created_at`** - so the line lands where the write
  happened, not today.

  What it deliberately does **not** touch: `resume_board.updated_at`. Bumping that clock now would
  claim the card was worked on today, which is exactly the kind of lie the archiver dates cards by
  (archiver/AGENTS.md). The interviews' `scheduled_at` values that came from the sheet are
  midnight, like every other imported timestamp; the section's pencil is the way to fix one.

  Idempotent: the same action text is never inserted twice for a card, so a re-run (or a run after
  the live path has written its own lines) is a no-op for the rows it already covered. Cards
  without a `resume_board` row are skipped - `from_state` has nothing to name.

  Run it (from the repo root, against the cluster's Postgres):

      kubectl exec -i deploy/postgres -- psql -U cvt -d cvt -v ON_ERROR_STOP=1 < scripts/backfill_interview_history.sql

  or, from the host through a port-forward (PowerShell needs the value set explicitly - an empty
  `DATABASE_SSLMODE` is *deleted* by the shell, root AGENTS.md trap 18):

      $env:DB_BACKEND="postgres"; $env:DATABASE_URL="postgresql://cvt:cvt@localhost:5432/cvt"
      $env:DATABASE_SSLMODE="disable"
      python -c "import psycopg,pathlib; c=psycopg.connect('postgresql://cvt:cvt@localhost:5432/cvt'); c.cursor().execute(pathlib.Path('scripts/backfill_interview_history.sql').read_text(encoding='utf-8')); c.commit()"

  It is a **one-off data repair**, not a migration: nothing in the runtime depends on it, and the
  file stays in `scripts/` as the written record of what it inserted (scripts/AGENTS.md).
*/

begin;

with lines as (
    select i.job_id,
           i.created_at as at,
           coalesce(b.stage, 'scraped') as stage,
           'Interview added: ' || i.type || ', ' ||
               to_char(i.scheduled_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as action
      from resume_interview i
      join resume_board b on b.job_id = i.job_id
)
insert into resume_history (job_id, actor, action, kind, from_state, to_state, at)
select l.job_id, 'Candidate', l.action, 'move', l.stage, l.stage, l.at
  from lines l
 where not exists (
        select 1
          from resume_history h
         where h.job_id = l.job_id
           and h.action = l.action
       );

-- What History now holds per card, and the clock that must not have moved.
select r.external_id,
       count(*) filter (where h.action like 'Interview%') as interview_lines,
       max(b.updated_at) as board_clock
  from resumes r
  join resume_board b on b.job_id = r.job_id
  left join resume_history h on h.job_id = r.job_id
 where exists (select 1 from resume_interview i where i.job_id = r.job_id)
 group by r.external_id
 order by r.external_id;

commit;
