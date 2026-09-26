"""Seed the board from the operator's job-search spreadsheet.

    python scripts/seed_board.py --csv "D:\\Downloads\\Job Search - Main.csv" --user-id u-... --dry-run
    python scripts/seed_board.py --csv "D:\\Downloads\\Job Search - Main.csv" --user-id u-...

Why a script rather than SQL: the spreadsheet is a *working* document. One row per vacancy,
the operator's own state vocabulary (`NA`, `OLD`, `Applied`, `T: Refused`, ...) and up to nine
dated steps. Turning that into board rows means deciding what each state means *here*, and that
decision has to be reviewable, testable and repeatable - `--dry-run` prints the whole plan and
writes nothing, and a second run changes nothing (the `Imported: ` marker in `resume_history` is
how a card remembers where it came from).

Per spreadsheet row it writes:

* the card (`resumes`), **adopted** by `(source, external_id)` when the scout already created
  that vacancy - never inserted twice, because the board renders every row whatever its owner
  (`CONSTITUTION.md` invariant 17);
* the column (`resume_board.stage`) and, for a row the sheet marks refused, the archive;
* the timeline (`resume_history`): one row per dated step, each prefixed with `Imported: `, so
  provenance is visible and `--force` can rewrite exactly what it wrote;
* the cover letter the sheet carries (`resume_cover_letter`), as `completed` with a **null**
  model - this system did not write that letter, and claiming otherwise would be a lie.

What it deliberately does not do:

* invent a column for a state that has none. `NA`, `OLD`, `Inactive`, `Doubts`, `Maybe later`
  and `Created` all mean "found, nothing in this system ran" -> **Scraped**; the exact wording
  survives in the card's history.
* store what the schema has no place for (salary desired/offered, staff, match, days passed,
  published on) - those ride along in one history note per card instead.
* touch a card it has already imported (unless `--force`), or a card the sheet does not mention.
"""

import argparse
import csv
import html
import re
import sys
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlparse

sys.stdout.reconfigure(encoding="utf-8")

# Every history row this script writes carries this prefix: it is the provenance marker and the
# handle `--force` uses to rewrite (and only rewrite) imported rows.
MARKER = "Imported: "
ACTION_LIMIT = 500  # resume_history.action is 1..500 chars (a DB CHECK)

# The sheet's terminal states -> the board's columns. Anything absent means "nothing happened",
# which is Scraped: the column the ingest leaves a card in.
STATE_STAGE = {
    "Applied": "applied",
    "T: Interview": "interviewing",
    "T: Interview(went well)": "interviewing",
    "T: Technical Interview (went bad)": "interviewing",
}
REFUSED_STATES = {"I: Refused": "Candidate", "T: Refused": "Company"}
# Why a refusal happened, in the board's own Action vocabulary (both are seeded defaults).
REFUSAL_REASON = {"Candidate": "Withdrawn by me", "Company": "Rejected by company"}

DOU_VACANCY = re.compile(r"/vacancies/(\d+)")
DJINNI_VACANCY = re.compile(r"/jobs/(\d+)")
APPLY_TAIL = "Відгукнутись на вакансію"
DATE_FORMATS = ("%m/%d/%Y", "%d/%m/%Y", "%Y-%m-%d")


def log(message: str) -> None:
    print(message, flush=True)


def clip(text: str, limit: int = ACTION_LIMIT - len(MARKER)) -> str:
    """Fit a payload into `resume_history.action` without losing the marker."""
    text = re.sub(r"\s+", " ", text).strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def read_rows(path: Path) -> list[dict]:
    """The CSV as dicts, with Google Sheets' multi-line headers normalised."""
    with open(path, newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        raw_fields = list(reader.fieldnames or [])
        fields = [name.replace("\n", " ").strip() for name in raw_fields]
        rows = [
            {
                name.replace("\n", " ").strip(): html.unescape((raw[key] or "").strip())
                for name, key in zip(fields, raw_fields, strict=True)
            }
            for raw in reader
        ]
    if not fields or "URL" not in fields:
        raise SystemExit(f"{path}: not the expected spreadsheet export (columns: {fields})")
    return rows


def key_of(row: dict) -> tuple[str, str]:
    """The board identity of a spreadsheet row: `(source, external_id)`.

    The source is the site slug the schema allows (`^[a-z0-9][a-z0-9-]{1,31}$`, so
    `trading.space` becomes `tradingspace`) and the id is the vacancy number in the URL - the
    same number the site itself uses, which is what makes a sheet row and a scouted card the
    same card.
    """
    url = row.get("URL", "")
    host = urlparse(url).netloc.lower()
    if "dou.ua" in host:
        source = "dou"
    elif "djinni" in host:
        source = "djinni"
    else:
        source = re.sub(r"[^a-z0-9-]", "", host.split(".")[0].lower()) or "other"
    found = DOU_VACANCY.search(url) or DJINNI_VACANCY.search(url)
    external_id = found.group(1) if found else (row.get("Job ID") or url).strip()
    return source, external_id


def job_id_of(source: str, external_id: str) -> str:
    """A deterministic `job_id` for a card this script creates (`dou-374708`).

    The column is opaque and shape-guarded, so a readable one is free - and a *deterministic*
    one means a half-finished import can simply be re-run.
    """
    return f"{source}-{external_id}"[:80]


def stage_for_step(text: str) -> str | None:
    """Which column a dated step puts the card in, or None when it does not move it."""
    low = text.lower()
    if "offered" in low or "offer" in low:
        return "offer"
    if "interview" in low:
        return "interviewing"
    if "$" in text or "range" in low:
        return "negotiating"
    if "applied" in low:
        return "applied"
    return None


def parse_date(value: str) -> datetime | None:
    for pattern in DATE_FORMATS:
        try:
            return datetime.strptime(value, pattern).replace(tzinfo=UTC)
        except ValueError:
            continue
    return None


# Board order, used to keep a card's column monotonic: a later sheet line never moves a card
# backwards, and the final column is the furthest point the row reached.
STAGE_ORDER = ["scraped", "prepare", "applied", "negotiating", "interviewing", "offer"]


def later(left: str, right: str) -> str:
    return left if STAGE_ORDER.index(left) >= STAGE_ORDER.index(right) else right


@dataclass
class Step:
    """One dated line of the sheet's own log (`S1.Name` / `S1.Date`)."""

    at: datetime
    actor: str
    text: str
    stage: str


@dataclass
class Plan:
    """What one spreadsheet row becomes on the board."""

    source: str
    external_id: str
    job_id: str
    title: str
    company: str
    url: str
    description: str
    stage: str
    steps: list[Step] = field(default_factory=list)
    note: str = ""
    cover_letter: str = ""
    archived_actor: str | None = None
    archived_reason: str | None = None
    merged: int = 0

    @property
    def key(self) -> tuple[str, str]:
        return self.source, self.external_id


def steps_of(row: dict, fallback: datetime) -> list[Step]:
    """The sheet's `S1..S9` columns as a monotonic timeline.

    `T:` means the employer moved, `I:` means the operator did - that prefix is the only actor
    information the sheet carries, and it maps onto the board's own two-word vocabulary.
    """
    steps: list[Step] = []
    at = fallback
    reach = "scraped"
    for index in range(1, 10):
        name = (row.get(f"S{index}.Name") or "").strip()
        if not name:
            continue
        at = parse_date((row.get(f"S{index}.Date") or "").strip()) or at
        actor = "Company" if name.lower().startswith("t:") else "Candidate"
        text = re.sub(r"^[tiTI]:\s*", "", name).strip()
        reach = later(reach, stage_for_step(text) or reach)
        steps.append(Step(at=at, actor=actor, text=text, stage=reach))
    return steps


def note_of(row: dict) -> str:
    """The sheet's columns the schema has no place for, kept as one readable line."""
    pairs = [
        ("Last state", row.get("Last State")),
        ("Impact", row.get("Impact")),
        ("Match", row.get("Match")),
        ("Location", row.get("Location")),
        (
            "Salary",
            " → ".join(p for p in (row.get("Salary Desired"), row.get("Salary Offered")) if p),
        ),
        ("Recruiter", row.get("Staff")),
        ("Days passed", row.get("Days Passed")),
        ("Published", row.get("Published On")),
    ]
    return " · ".join(f"{label}={value.strip()}" for label, value in pairs if (value or "").strip())


def plan_of(row: dict, fallback: datetime) -> Plan:
    """One spreadsheet row -> the card, its column, its timeline and its refusal (if any)."""
    source, external_id = key_of(row)
    last_state = (row.get("Last State") or "").strip()
    steps = steps_of(row, fallback)
    reach = steps[-1].stage if steps else "scraped"
    stage = later(reach, STATE_STAGE.get(last_state, "scraped"))

    description = row.get("Job", "")
    if APPLY_TAIL in description:
        description = description[: description.index(APPLY_TAIL)].rstrip()

    actor = REFUSED_STATES.get(last_state)
    if actor == "Candidate":
        reason = (
            "Salary mismatch"
            if (row.get("Salary Desired") or row.get("Salary Offered"))
            else "Withdrawn by me"
        )
    else:
        reason = REFUSAL_REASON[actor] if actor else None

    return Plan(
        source=source,
        external_id=external_id,
        job_id=job_id_of(source, external_id),
        title=(row.get("Role") or "").strip(),
        company=(row.get("Company") or "").strip(),
        url=(row.get("URL") or "").strip(),
        description=description.strip(),
        stage=stage,
        steps=steps,
        note=note_of(row),
        cover_letter=(row.get("Cover Letter") or "").strip(),
        archived_actor=actor,
        archived_reason=reason,
    )


def merge_duplicates(plans: list[Plan]) -> tuple[list[Plan], list[Plan]]:
    """Collapse rows the sheet repeats (the same vacancy twice).

    The sheet has two: `dou 372122` (the same Mobilunity ad recorded twice) and `dou 364961`
    (one vacancy posted by two agencies). The board cannot hold both - the business key is
    unique - so the more advanced plan wins and the other is reported.
    """
    kept: dict[tuple[str, str], Plan] = {}
    dropped: list[Plan] = []
    for plan in plans:
        current = kept.get(plan.key)
        if current is None:
            kept[plan.key] = plan
            continue
        winner, loser = (current, plan)
        if STAGE_ORDER.index(plan.stage) > STAGE_ORDER.index(current.stage) or (
            plan.stage == current.stage and len(plan.steps) > len(current.steps)
        ):
            winner, loser = plan, current
        winner.merged += loser.merged + 1
        if not winner.cover_letter:
            winner.cover_letter = loser.cover_letter
        kept[plan.key] = winner
        dropped.append(loser)
    return list(kept.values()), dropped


def existing_cards(conn, keys: list[tuple[str, str]]) -> dict[tuple[str, str], dict]:
    """What the board already holds for these vacancies - **any** owner, any status.

    Board-scoped on purpose (`CONSTITUTION.md` invariant 17): the scout created 67 of these as
    `scout@local`, the board shows all of them, and inserting a second row per vacancy under the
    operator's own account would put two cards for one job on the screen.
    """
    if not keys:
        return {}
    with conn.cursor() as cur:
        cur.execute(
            """
            select r.job_id, r.user_id, r.source, r.external_id, r.status,
                   (r.description_raw is not null) as has_description,
                   b.archived_at is not null as archived,
                   (c.job_id is not null) as has_letter
              from resumes r
              left join resume_board b on b.job_id = r.job_id
              left join resume_cover_letter c on c.job_id = r.job_id
             where r.source = any(%s) and r.external_id = any(%s)
            """,
            ([source for source, _ in keys], [external for _, external in keys]),
        )
        return {(row["source"], row["external_id"]): row for row in cur.fetchall()}


def imported_job_ids(conn) -> set[str]:
    """Cards this script already wrote - the marker on their history rows is the receipt."""
    with conn.cursor() as cur:
        cur.execute(
            "select distinct job_id from resume_history where action like %s", (MARKER + "%",)
        )
        return {row["job_id"] for row in cur.fetchall()}


def write_card(cur, plan: Plan, job_id: str, user_id: str, adopt: bool) -> None:
    """Insert the card, or refresh the descriptive fields of the row the scout already made.

    `status` is deliberately untouched on conflict: import says nothing about the worker's own
    claim state, and a row another process is chewing on must not be pushed back to `submitted`.
    """
    cur.execute(
        """
        insert into resumes (job_id, user_id, external_id, source, title, company, source_url,
                             description_raw, cv_version, status)
        values (%s, %s, %s, %s, %s, %s, %s, %s, 'v1', 'submitted')
        on conflict (job_id) do update
           set user_id      = excluded.user_id,
               title        = excluded.title,
               company      = excluded.company,
               source_url   = excluded.source_url,
               description_raw = coalesce(excluded.description_raw,
                                          resumes.description_raw)
        """,
        (
            job_id,
            user_id,
            plan.external_id,
            plan.source,
            plan.title,
            plan.company,
            plan.url,
            plan.description or None,
        ),
    )
    _ = adopt


def write_column(cur, plan: Plan, job_id: str, archived_already: bool) -> None:
    """Set the column; only the import ever sets an archive, and never over an existing one."""
    if plan.archived_actor and not archived_already:
        cur.execute(
            """
            insert into resume_board (job_id, stage, archived_at, archived_actor, archived_reason)
            values (%s, %s, now(), %s, %s)
            on conflict (job_id) do update set stage = excluded.stage,
                                               archived_at = excluded.archived_at,
                                               archived_actor = excluded.archived_actor,
                                               archived_reason = excluded.archived_reason
            """,
            (job_id, plan.stage, plan.archived_actor, clip(plan.archived_reason or "")),
        )
        return
    cur.execute(
        """
        insert into resume_board (job_id, stage) values (%s, %s)
        on conflict (job_id) do update set stage = excluded.stage
        """,
        (job_id, plan.stage),
    )


def write_history(cur, plan: Plan, job_id: str, fallback: datetime) -> int:
    """One row per dated sheet line, plus the note, plus the refusal - all marked `Imported: `."""
    rows: list[tuple] = []
    previous = "imported"
    at = fallback
    for step in plan.steps:
        at = step.at
        rows.append((job_id, at, step.actor, MARKER + clip(step.text), "move", previous, step.stage))
        previous = step.stage
    if plan.note:
        rows.append(
            (job_id, at, "Candidate", MARKER + clip(plan.note), "move", previous, plan.stage)
        )
    if plan.archived_actor:
        rows.append(
            (
                job_id,
                at,
                plan.archived_actor,
                MARKER + clip(plan.archived_reason or ""),
                "archive",
                "active",
                "archived",
            )
        )
    if not rows:
        return 0
    cur.executemany(
        """
        insert into resume_history (job_id, at, actor, action, kind, from_state, to_state)
        values (%s, %s, %s, %s, %s, %s, %s)
        """,
        rows,
    )
    return len(rows)


def write_letter(cur, plan: Plan, job_id: str) -> bool:
    """The letter the sheet carries. `do nothing` on conflict: a generated one always wins."""
    if not plan.cover_letter:
        return False
    cur.execute(
        """
        insert into resume_cover_letter (job_id, status, text, attempts)
        values (%s, 'completed', %s, 0)
        on conflict (job_id) do nothing
        """,
        (job_id, plan.cover_letter),
    )
    return cur.rowcount > 0



def build_plans(rows: list[dict]) -> tuple[list[Plan], list[Plan]]:
    """Every spreadsheet row -> a plan, with the sheet's own duplicates collapsed."""
    now = datetime.now(UTC)
    plans = []
    for row in rows:
        fallback = parse_date((row.get("Published On") or "").strip()) or now
        plans.append(plan_of(row, fallback))
    return merge_duplicates(plans)


def describe(plan: Plan, row: dict | None) -> str:
    """One line of the dry run: what happens to this row, and why."""
    verdict = "refresh" if row else "create "
    marks = []
    if plan.archived_actor:
        marks.append(f"ARCHIVED({plan.archived_actor}/{plan.archived_reason})")
    if plan.cover_letter:
        marks.append("letter")
    if plan.note:
        marks.append("note")
    if plan.merged:
        marks.append(f"merged {plan.merged}")
    mark = ("  " + " ".join(marks)) if marks else ""
    return (
        f"  {verdict}  {plan.job_id:22} [{plan.stage:12}] {plan.company[:24]:24} "
        f"— {plan.title[:44]:44} steps={len(plan.steps)}{mark}"
    )


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Seed the board from the job-search spreadsheet")
    parser.add_argument("--csv", required=True, help="the exported spreadsheet (CSV)")
    parser.add_argument(
        "--user-id",
        required=True,
        help="the app_users.id that will own these cards (the operator's own account)",
    )
    parser.add_argument("--dsn", default=None, help="Postgres DSN (default: DATABASE_URL)")
    parser.add_argument("--dry-run", action="store_true", help="print the plan and write nothing")
    parser.add_argument(
        "--force",
        action="store_true",
        help="re-import cards this script already wrote (rewrites only its own history rows)",
    )
    parser.add_argument("--limit", type=int, default=0, help="stop after N cards (0 = all)")
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    csv_path = Path(args.csv)
    if not csv_path.exists():
        log(f"[fail] {csv_path} does not exist")
        return 1

    rows = read_rows(csv_path)
    plans, dropped = build_plans(rows)
    counts: dict[str, int] = {}
    for plan in plans:
        counts[plan.stage] = counts.get(plan.stage, 0) + 1

    log(f"spreadsheet rows : {len(rows)}")
    log(f"distinct cards   : {len(plans)}  (dropped as duplicates: {len(dropped)})")
    for plan in dropped:
        log(f"    duplicate: {plan.job_id} {plan.company} - {plan.title[:50]!r}")
    log("columns          : " + ", ".join(f"{stage}={n}" for stage, n in sorted(counts.items())))
    log(f"refused          : {sum(1 for p in plans if p.archived_actor)}")
    log(f"with a letter    : {sum(1 for p in plans if p.cover_letter)}")

    if args.dsn is None:
        import config

        args.dsn = config.DATABASE_URL
    if not args.dsn:
        log("[fail] no DSN: pass --dsn or set DATABASE_URL")
        return 1

    import psycopg
    from psycopg.rows import dict_row

    created = adopted = skipped = letters = history = 0
    with psycopg.connect(args.dsn, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute("select id from app_users where id = %s", (args.user_id,))
            if cur.fetchone() is None:
                # Same reason the scout refuses to run: cards owned by nobody look fine on the
                # board while the operator's drag would publish a stranger's owner.
                log(f"[fail] {args.user_id!r} is not an app_users row")
                return 1

        existing = existing_cards(conn, [plan.key for plan in plans])
        already = imported_job_ids(conn)
        log(f"already on board : {len(existing)}  (imported by this script: {len(already)})")

        selected = plans[: args.limit] if args.limit else plans
        if args.dry_run:
            log("\ndry run - nothing is written:")
            for plan in selected:
                log(describe(plan, existing.get(plan.key)))
            return 0

        log("\napplying:")
        for plan in selected:
            row = existing.get(plan.key)
            job_id = row["job_id"] if row else plan.job_id
            if job_id in already and not args.force:
                skipped += 1
                continue
            fallback = plan.steps[0].at if plan.steps else datetime.now(UTC)
            with conn.transaction():
                with conn.cursor() as cur:
                    if args.force:
                        cur.execute(
                            "delete from resume_history where job_id = %s and action like %s",
                            (job_id, MARKER + "%"),
                        )
                    write_card(cur, plan, job_id, args.user_id, adopt=row is not None)
                    write_column(cur, plan, job_id, archived_already=bool(row and row["archived"]))
                    history += write_history(cur, plan, job_id, fallback)
                    if write_letter(cur, plan, job_id):
                        letters += 1
            if row is None:
                created += 1
            else:
                adopted += 1
    log("")
    log(f"created          : {created}")
    log(f"adopted (scout)  : {adopted}")
    log(f"skipped (already imported): {skipped}")
    log(f"cover letters    : {letters}")
    log(f"history rows     : {history}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
