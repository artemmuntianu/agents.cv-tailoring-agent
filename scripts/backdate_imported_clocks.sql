/*
  One-off: back-date `resume_board.updated_at` for the cards the 2026-09-26 spreadsheet import
  stamped with its own clock.

  Why this exists: `python -m archiver` refuses a card in `applied` that no operator action has
  touched for `AUTO_ARCHIVE_AFTER_DAYS` (10) days, and its clock is `resume_board.updated_at` - the
  board's own activity field (apps/worker/archiver/AGENTS.md). The import wrote the board's rows directly, so
  that column took its `now()` *default*: nine cards looked "touched" at 2026-09-26 23:18:23 (the
  same microsecond for all of them) although their real last activity is in `resume_history.at` -
  the date the import itself recorded from the sheet (dates only, so midnight, exactly like
  `backfill_interviews.sql`).

  What that looked like from the outside: the sweep ran every morning, reported `candidates: 0` in
  the ledger, and cards that went silent on 2026-09-18 stayed in Applied - the operator reported two
  of them (`373908`, `373812`). Nothing in the archiver was wrong; the field it dates cards by had
  been reset by the import. Without this repair the nine would each have waited ten days *from the
  import* (2026-10-06) before the sweep would even look at them.

  The rule, deliberately narrow - a card is corrected only when **all three** hold:

    * its whole history is the import (`every action like 'Imported: %'`), so the operator has never
      acted on it since;
    * it is not archived (an archived card's clock is irrelevant - the sweep never considers one);
    * the board row was stamped before 2026-09-27, i.e. *during the import window*: a card the
      operator touched later keeps its `updated_at`, because a recorded action, a move, a restore or
      a details save (which writes no history row on purpose, invariant 28) all bump that column and
      none of them may be second-guessed here.

  The new value is the newest timestamp the import wrote for that card - the last thing the sheet
  said about it - so the sweep now counts the real silence (13 days for the two reported cards).

  Idempotent: afterwards `updated_at <= last history at`, so a second run updates nothing. The
  column only ever moves backwards, and no other column is touched - not `stage`, not
  `resumes.status` (invariants 19, 27).

  Run it (from the repo root, against the cluster's Postgres):

      kubectl exec -i deploy/postgres -- psql -U cvt -d cvt -v ON_ERROR_STOP=1 < scripts/backdate_imported_clocks.sql

  or, from the host through a port-forward (PowerShell needs the value set explicitly - an empty
  `DATABASE_SSLMODE` is *deleted* by the shell, root AGENTS.md trap 18):

      $env:DB_BACKEND="postgres"; $env:DATABASE_URL="postgresql://cvt:cvt@localhost:5432/cvt"
      $env:DATABASE_SSLMODE="disable"
      python -c "import psycopg,pathlib; c=psycopg.connect('postgresql://cvt:cvt@localhost:5432/cvt'); c.cursor().execute(pathlib.Path('scripts/backdate_imported_clocks.sql').read_text(encoding='utf-8')); c.commit()"

  It is a **one-off data repair**, not a migration: nothing in the runtime depends on it, and the
  file stays in `scripts/` as the written record of what it changed (scripts/AGENTS.md).
*/

begin;

-- Who is about to be corrected. Read this before the update; the same predicate drives it.
select r.external_id, r.source, b.stage,
       b.updated_at as clock_before,
       h.last_at as real_last_activity
  from resume_board b
  join resumes r on r.job_id = b.job_id
  join lateral (
        select max(at) as last_at,
               count(*) filter (where action not like 'Imported:%') as real_rows
          from resume_history x
         where x.job_id = b.job_id
       ) h on true
 where b.archived_at is null
   and b.updated_at < '2026-09-27'
   and h.real_rows = 0
   and h.last_at is not null
   and b.updated_at > h.last_at
 order by h.last_at asc, r.external_id;

update resume_board b
   set updated_at = h.last_at
  from (
        select job_id,
               max(at) as last_at,
               count(*) filter (where action not like 'Imported:%') as real_rows
          from resume_history
         group by job_id
       ) h
 where h.job_id = b.job_id
   and b.archived_at is null
   and b.updated_at < '2026-09-27'
   and h.real_rows = 0
   and h.last_at is not null
   and b.updated_at > h.last_at;

-- What the next sweep now sees: cards in the swept column, silent for ten days or more.
select count(*) as candidates_10d
  from resume_board b
 where b.archived_at is null
   and b.stage = 'applied'
   and b.updated_at < now() - interval '10 days';

commit;
