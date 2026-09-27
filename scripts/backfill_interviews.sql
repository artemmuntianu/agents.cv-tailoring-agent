/*
  One-off: backfill the **Interviews** section for the cards that reached Interviewing.

  Why this exists: `resume_interview` arrived on 2026-09-27, so the cards that were already
  standing in the Interviewing column had their interviews only in `resume_history` - all of it
  written by the 2026-09-26 spreadsheet import (`Imported: ...` rows, dated from the sheet, so
  **the times are midnight**: the sheet carried dates, not clock times - fix them with the
  card's pencil if you care).

  What it derives, per card, from History alone:

    * every move **into** interviewing (`to_state = 'interviewing'`, `from_state <> 'interviewing'`)
      becomes one interview, dated at that move;
    * its `type` and `result` come from the *best note* around it, in this order: what the move
      **into** interviewing says itself when it says more than the bare word "Interview", else the
      **first** informative note from that move up to the next one. The importer's
      `Last state=...` metadata row and the bare word "Interview" are never used. "First" and not
      "last" on purpose: the first thing written after the round is what the round was like
      ("went very well", "went bad", "successful"), while a later "Refused"/"re-negotiated" note is
      about the *application* - and the card's badge and its History already say that;
    * the `Imported: ` prefix is stripped for the section (History keeps the original wording);
    * the four types are inferred from keywords: `manager`/`management` -> Management Interview,
      `technical`/`tech`/`coding`/`test task`/`take-home` -> Technical Interview,
      `final`/`offer` -> Final Interview, anything else -> Initial Interview;
    * a card standing in Interviewing **without** any move into it gets one placeholder interview
      at the card's last change, so a column that promises the section is never silent.

  Idempotent twice over: a card that already has *any* interview row is skipped, and the
  placeholder pass skips a card whose history holds a move into interviewing. Re-running it is a
  no-op.

  Run it (from the repo root, against the cluster's Postgres):

      kubectl exec -i deploy/postgres -- psql -U cvt -d cvt -v ON_ERROR_STOP=1 < scripts/backfill_interviews.sql

  or, from the host through a port-forward (PowerShell needs the value set explicitly - an empty
  `DATABASE_SSLMODE` is *deleted* by the shell, root AGENTS.md trap 18):

      $env:DB_BACKEND="postgres"; $env:DATABASE_URL="postgresql://cvt:cvt@localhost:5432/cvt"
      $env:DATABASE_SSLMODE="disable"
      python -c "import psycopg,pathlib; c=psycopg.connect('postgresql://cvt:cvt@localhost:5432/cvt'); c.cursor().execute(pathlib.Path('scripts/backfill_interviews.sql').read_text(encoding='utf-8')); c.commit()"

  It is a **one-off data repair**, not a migration: nothing in the runtime depends on it, and the
  file stays in `scripts/` as the written record of what was inserted (scripts/AGENTS.md).
*/

begin;

with marks as (
    -- every move that put a card *into* Interviewing, with the next one (if any)
    select h.id,
           h.job_id,
           h.at,
           h.action,
           lead(h.at) over (partition by h.job_id order by h.at, h.id) as next_at
      from resume_history h
     where h.kind = 'move'
       and h.to_state = 'interviewing'
       and h.from_state <> 'interviewing'
), notes as (
    -- The informative notes that belong to one mark: same card, at or after it, before the next
    -- mark. The earliest of them is the round's own outcome; a later refusal or negotiation note
    -- belongs to the application, not to the interview.
    select m.id as event_id,
           n.action,
           row_number() over (partition by m.id order by n.at asc, n.id asc) as rank
      from marks m
      join resume_history n
        on n.job_id = m.job_id
       and n.kind = 'move'
       and n.from_state = 'interviewing'
       and n.at >= m.at
       and (m.next_at is null or n.at < m.next_at)
     where btrim(coalesce(n.action, '')) <> ''
       and n.action not like 'Imported: Last state=%'
       and lower(btrim(replace(n.action, 'Imported: ', ''))) <> 'interview'
), best as (
    select m.job_id,
           m.at,
           coalesce(
               case
                   when m.action not like 'Imported: Last state=%'
                        and lower(btrim(replace(m.action, 'Imported: ', '')))
                            not in ('', 'interview')
                   then m.action
               end,
               n.action
           ) as note
      from marks m
      left join notes n on n.event_id = m.id and n.rank = 1
     where not exists (select 1 from resume_interview i where i.job_id = m.job_id)
)
insert into resume_interview (job_id, scheduled_at, type, result)
select b.job_id,
       b.at,
       case
           when b.note ilike '%manager%' or b.note ilike '%management%'
               then 'Management Interview'
           when b.note ilike '%technical%' or b.note ilike '%tech %' or b.note ilike '%coding%'
                or b.note ilike '%test task%' or b.note ilike '%take-home%'
               then 'Technical Interview'
           when b.note ilike '%final%' or b.note ilike '%offer%'
               then 'Final Interview'
           else 'Initial Interview'
       end,
       left(nullif(btrim(replace(coalesce(b.note, ''), 'Imported: ', '')), ''), 2000)
  from best b
 order by b.job_id, b.at;

-- A card standing in Interviewing whose history has no move into it: one placeholder, so the
-- section the column promises is never empty. (No such card on 2026-09-27 - this is for the
-- hand-made or hand-imported ones.)
insert into resume_interview (job_id, scheduled_at, type, result)
select b.job_id, b.updated_at, 'Initial Interview', null
  from resume_board b
 where b.stage = 'interviewing'
   and not exists (select 1 from resume_interview i where i.job_id = b.job_id)
   and not exists (
           select 1 from resume_history h
            where h.job_id = b.job_id
              and h.kind = 'move'
              and h.to_state = 'interviewing'
       );

commit;

-- What the section now shows (this is the report; the insert above changed the rows).
select i.job_id,
       r.title,
       i.scheduled_at,
       i.type,
       i.result
  from resume_interview i
  join resumes r on r.job_id = i.job_id
 order by i.job_id, i.scheduled_at;
