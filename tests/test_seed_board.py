"""The importer's pure half: the spreadsheet -> board plan, and every decision it encodes.

The DB half is verified live (it is operator tooling, like `scripts/local-deploy.ps1`). What is
pinned here is what would silently mislabel 226 cards: the state vocabulary, the vacancy
identity, the timeline, and the exact shape of the `Imported: ` marker `--force` rewrites.
"""

import csv
import re
from datetime import UTC, datetime

import pytest

from scripts.seed_board import (
    ACTION_LIMIT,
    MARKER,
    clip,
    job_id_of,
    key_of,
    later,
    merge_duplicates,
    plan_of,
    read_rows,
    stage_for_step,
)

# The real export's headers, newlines and all (Google Sheets wraps them).
HEADER = [
    "",
    "Company",
    "URL",
    "Job ID",
    "Impact",
    "Role",
    "Tech Stack",
    "Benefits",
    "Job",
    "Cover Letter",
    "Match",
    "Location",
    "Salary\nDesired",
    "Salary\nOffered",
    "Staff",
    "Days\nPassed",
    "Last\nState",
    "Published\nOn",
    "S1.Name",
    "S1.Date",
    "S2.Name",
    "S2.Date",
    "S3.Name",
    "S3.Date",
]

DOU_URL = "https://jobs.dou.ua/companies/acme/vacancies/374708"
FALLBACK = datetime(2026, 9, 1, tzinfo=UTC)


def sheet_row(**overrides):
    """One spreadsheet row as `read_rows` hands it to the planner (wrapped headers unwrapped).

    Overrides accept either spelling - `Last State` or the export's own `Last\\nState`.
    """
    row = {name.replace("\n", " "): "" for name in HEADER}
    row.update(
        {
            "Company": "Acme",
            "URL": DOU_URL,
            "Job ID": "374708",
            "Role": "Senior .NET Engineer",
            "Job": "About the role\n\n• Build things\n\nВідгукнутись на вакансію",
            "Cover Letter": "Dear Hiring Manager, ...",
            "Published On": "9/9/2026",
            "S1.Name": "Created",
            "S1.Date": "9/9/2026",
            "Last State": "Applied",
        }
    )
    row.update({name.replace("\n", " "): value for name, value in overrides.items()})
    return row


def write_sheet(tmp_path, rows):
    """Write rows back out with the export's own wrapped headers, so `read_rows` is exercised."""
    path = tmp_path / "sheet.csv"
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=HEADER)
        writer.writeheader()
        writer.writerows([{raw: row[raw.replace("\n", " ")] for raw in HEADER} for row in rows])
    return path


def test_the_wrapped_headers_are_read_as_values(tmp_path):
    """The regression this importer was born with: `zip(fields, row)` read keys, not values."""
    rows = read_rows(write_sheet(tmp_path, [sheet_row()]))
    assert rows[0]["URL"] == DOU_URL
    assert rows[0]["Last State"] == "Applied"
    assert rows[0]["Salary Desired"] == ""
    assert rows[0]["Company"] == "Acme"


def test_a_file_that_is_not_the_export_is_refused(tmp_path):
    path = tmp_path / "other.csv"
    path.write_text("a,b\n1,2\n", encoding="utf-8")
    with pytest.raises(SystemExit):
        read_rows(path)


def test_the_vacancy_identity_comes_from_the_link():
    # The number in the URL is the site's own vacancy id - the same one a scouted card carries.
    assert key_of({"URL": DOU_URL}) == ("dou", "374708")
    assert key_of({"URL": "https://djinni.co/jobs/838324/"}) == ("djinni", "838324")
    # A site without a numeric id in the path keeps the sheet's own id column.
    assert key_of({"URL": "https://adaptiq.co/vacancies/x/", "Job ID": "92220261"}) == (
        "adaptiq",
        "92220261",
    )
    # `trading.space` cannot be a source (the column is a slug: `^[a-z0-9][a-z0-9-]{1,31}$`).
    assert key_of({"URL": "https://trading.space/career/x/", "Job ID": "ts_1"}) == ("trading", "ts_1")
    # An empty id column is fine as long as the URL has one.
    assert key_of({"URL": DOU_URL, "Job ID": ""}) == ("dou", "374708")


def test_the_generated_job_id_satisfies_the_db_shape_guard():
    for source, external_id in [("dou", "374708"), ("trading", "tradingspace_analyticslead")]:
        job_id = job_id_of(source, external_id)
        assert re.fullmatch(r"[A-Za-z0-9_.:-]{4,80}", job_id), job_id



def test_the_sheet_states_map_onto_the_columns_the_board_has():
    assert plan_of(sheet_row(**{"Last\nState": "Applied"}), FALLBACK).stage == "applied"
    assert plan_of(sheet_row(**{"Last\nState": "T: Interview"}), FALLBACK).stage == "interviewing"
    # Everything that means "found, nothing ran in this system" is Scraped - and the wording
    # survives in the history note.
    for state in ["NA", "OLD", "Inactive", "Doubts", "Maybe later", ""]:
        plan = plan_of(sheet_row(**{"Last\nState": state, "S2.Name": "", "S2.Date": ""}), FALLBACK)
        assert plan.stage == "scraped", state
        # The sheet's own wording survives - an empty state has nothing to record.
        assert (f"Last state={state}" in plan.note) == bool(state)


def test_the_timeline_is_monotonic_and_maps_the_actor():
    plan = plan_of(
        sheet_row(
            **{
                "S2.Name": "Applied",
                "S2.Date": "9/10/2026",
                "S3.Name": "T: replied with $ range",
                "S3.Date": "9/12/2026",
                "Last\nState": "T: Interview",
            }
        ),
        FALLBACK,
    )
    assert [(step.actor, step.stage) for step in plan.steps] == [
        ("Candidate", "scraped"),
        ("Candidate", "applied"),
        ("Company", "negotiating"),
    ]
    assert plan.steps[1].at == datetime(2026, 9, 10, tzinfo=UTC)
    # The column is the furthest point reached: an interview beats the salary talk before it.
    assert plan.stage == "interviewing"
    # A later line never moves the card backwards.
    assert later("interviewing", "applied") == "interviewing"
    assert later("scraped", "negotiating") == "negotiating"


def test_a_step_the_board_cannot_classify_does_not_move_the_card():
    plan = plan_of(
        sheet_row(
            **{
                "S2.Name": "Created",
                "S2.Date": "9/10/2026",
                "Last\nState": "Created",
            }
        ),
        FALLBACK,
    )
    assert [step.stage for step in plan.steps] == ["scraped", "scraped"]
    assert plan.stage == "scraped"


def test_a_step_moves_the_card_only_when_it_says_so():
    assert stage_for_step("Applied") == "applied"
    assert stage_for_step("Technical Interview (went bad)") == "interviewing"
    assert stage_for_step("Offered $") == "offer"
    assert stage_for_step("replied with $ range") == "negotiating"
    assert stage_for_step("Created") is None
    assert stage_for_step("Maybe later") is None


def test_a_refusal_keeps_its_column_and_gets_an_actor_and_a_reason():
    akvelon = plan_of(
        sheet_row(
            **{
                "Salary\nDesired": "$5,000",
                "Salary\nOffered": "$3,600",
                "S2.Name": "Applied",
                "S2.Date": "9/17/2026",
                "S3.Name": "T: Offered $",
                "S3.Date": "9/22/2026",
                "Last\nState": "I: Refused",
            }
        ),
        FALLBACK,
    )
    assert akvelon.stage == "offer", "an offer on the table is where the card belongs"
    assert (akvelon.archived_actor, akvelon.archived_reason) == ("Candidate", "Salary mismatch")

    rejected = plan_of(
        sheet_row(
            **{"S2.Name": "Applied", "S2.Date": "9/17/2026", "Last\nState": "T: Refused"}
        ),
        FALLBACK,
    )
    assert rejected.stage == "applied"
    assert (rejected.archived_actor, rejected.archived_reason) == ("Company", "Rejected by company")

    withdrawn = plan_of(
        sheet_row(**{"S2.Name": "Applied", "S2.Date": "9/9/2026", "Last\nState": "I: Refused"}),
        FALLBACK,
    )
    assert withdrawn.archived_reason == "Withdrawn by me", "no salary talk, no salary reason"


def test_the_job_description_loses_the_site_link():
    plan = plan_of(sheet_row(), FALLBACK)
    assert plan.description == "About the role\n\n• Build things"
    assert plan.title == "Senior .NET Engineer"
    assert plan.company == "Acme"
    assert plan.url == DOU_URL
    assert plan.cover_letter.startswith("Dear Hiring Manager")


def test_the_note_keeps_what_the_schema_cannot_hold():
    plan = plan_of(
        sheet_row(
            **{
                "Match": "4",
                "Location": "віддалено",
                "Salary\nDesired": "$5000-6000",
                "Staff": "Nataliya Piletska",
                "Days\nPassed": "4",
            }
        ),
        FALLBACK,
    )
    for fragment in ["Match=4", "Location=віддалено", "Salary=$5000-6000", "Recruiter=Nataliya"]:
        assert fragment in plan.note, fragment


def test_duplicate_rows_collapse_to_the_more_advanced_plan():
    plans, dropped = merge_duplicates(
        [
            plan_of(
                sheet_row(**{"Last\nState": "NA", "S2.Name": "NA", "S2.Date": "9/9/2026"}),
                FALLBACK,
            ),
            plan_of(sheet_row(), FALLBACK),  # the same vacancy, applied
        ]
    )
    assert len(plans) == 1 and len(dropped) == 1
    assert plans[0].stage == "applied"
    assert plans[0].merged == 1


def test_the_marker_fits_the_action_column():
    assert len(MARKER + clip("x" * 2000)) <= ACTION_LIMIT
    assert clip("  a\n\n b  ") == "a b"
