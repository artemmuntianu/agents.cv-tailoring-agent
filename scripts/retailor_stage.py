#!/usr/bin/env python
"""Re-tailor every card of one board column against the current master CV.

Why this exists
---------------
A `resumes` row is idempotent by business key - `(user_id, source, external_id, cv_version)` -
and `ACTIVE_STATUSES` includes `completed`, so the worker answers a re-published message with
`duplicate` and acks it without doing anything. A card that was tailored once therefore cannot be
re-tailored with its own version, and bumping the version alone is not enough either: the claim
only reaches `on conflict (job_id) do update` while **no sibling owns the new key**.

The state that makes a re-run legitimate is the one the board itself uses for a retry: leave the
row **parked** - a status outside `ACTIVE_STATUSES` - so `_claim_row` takes the re-claim branch.
That is what this script does for a whole column, and it pairs the park with the version bump
that says *why* (the master CV changed), so the row's key matches the message it publishes and a
redelivery is still deduplicated.

The cover letter is regenerated too. The cover consumer acks a `completed` letter as a duplicate,
so its row is reset to `queued` first - byte for byte what the board's own *Generate* button
claims (`apps/backoffice/src/lib/db.ts::markCoverRequested`).

Run it after `scripts/storage-files.ps1 -Action seed`, or the workers tailor against the old CV.

    python scripts/retailor_stage.py --stage prepare --cv-version v2            # plan only
    python scripts/retailor_stage.py --stage prepare --cv-version v2 --apply

Host-side access needs the two port-forwards from `docs/RUNBOOK.md`:

    kubectl port-forward svc/postgres 5432:5432
    kubectl port-forward svc/rabbitmq 5672:5672

and the environment a host-side run needs: `DATABASE_URL=postgresql://cvt:cvt@localhost:5432/cvt`
(plus `DATABASE_SSLMODE=disable` for the dev database) and a `RABBITMQ_URL` rebuilt against
`localhost` - `scripts/send-test-job.ps1` shows how the Secret's in-cluster URL is rebuilt, and
this script refuses a URL that still names the cluster DNS.
"""

import argparse
import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    # Windows consoles default to cp1252 and choke on emoji output.
    sys.stdout.reconfigure(encoding="utf-8")

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# The worker app lives under apps/worker after the monorepo move; its packages
# (config, agent, utils) are importable only from there.
APP_ROOT = os.path.join(REPO_ROOT, "apps", "worker")
if APP_ROOT not in sys.path:
    sys.path.insert(0, APP_ROOT)

# The dev Postgres serves plain TCP and config's default is `require`, so without this every
# connection dies with "server does not support SSL, but SSL was required" (AGENTS.md trap 18).
# An explicit DATABASE_SSLMODE in the environment still wins.
os.environ.setdefault("DATABASE_SSLMODE", "disable")

import config  # noqa: E402
from agent.contracts import CoverLetterMessage, ResumeTaskMessage  # noqa: E402
from utils import db as db_module  # noqa: E402
from utils.messaging import cover_queue_spec, get_queue, task_queue_spec  # noqa: E402

DEFAULT_STAGE = "prepare"
QUEUED_COVER_STATUS = "queued"
# What the parked row says while the re-run is in flight. The operator sees it in the card's
# *Tailoring Failed* chip - which is literally true: the previous result is being superseded.
SUPERSEDED_REASON = "Superseded: re-tailoring against master CV {version}"


def fetch_cards(store, stage):
    """Every active card of one column, with what a task message is built from.

    Archived (refused) cards are excluded: they are out of the pipeline, and re-tailoring them
    would publish work nobody asked for.
    """
    with store.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select r.job_id, r.user_id, r.external_id, r.source, r.title, r.company,
                       r.source_url, r.description_raw, r.cv_version, r.status,
                       coalesce(c.status, '') as cover_status
                  from resumes r
                  join resume_board b on b.job_id = r.job_id
             left join resume_cover_letter c on c.job_id = r.job_id
                 where b.stage = %s
                   and b.archived_at is null
              order by b.updated_at desc
                """,
                (stage,),
            )
            return [dict(row) for row in cur.fetchall()]


def park_for_reclaim(store, card, version):
    """Make the CV row claimable again and reset the cover-letter row - one transaction.

    Both writes happen *before* anything is published, for the same reason the board claims a
    cover letter before it publishes: a crash between the two would otherwise leave a message on
    its way with nothing for it to claim, and a publish failure would leave a row claiming work
    that is not coming. Parked-first means a failed publish is visible and re-draggable.
    """
    reason = SUPERSEDED_REASON.format(version=version)[:500]
    with store.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                update resumes
                   set cv_version = %s, status = 'failed', error = %s, updated_at = now()
                 where job_id = %s
                """,
                (version, reason, card["job_id"]),
            )
            cur.execute(
                """
                insert into resume_cover_letter (job_id, status) values (%s, 'queued')
                on conflict (job_id) do update
                   set status = 'queued', error = null, updated_at = now()
                 where resume_cover_letter.status <> 'running'
                """,
                (card["job_id"],),
            )
        conn.commit()


def build_task_message(card, version, enqueued_at):
    """The exact payload `ResumeTaskMessage` validates - built through the contract, not by hand.

    `cv_data` is left out on purpose: the worker downloads the master CV and validates that
    document, and an inline copy could be the stale one (`apps/backoffice/src/lib/vacancies.ts`
    makes the same choice).
    """
    return ResumeTaskMessage(
        job_id=card["job_id"],
        user_id=card["user_id"],
        external_id=card["external_id"],
        source=card["source"],
        title=card["title"] or "",
        company=card["company"] or "",
        source_url=card["source_url"],
        description_raw=card["description_raw"] or "",
        cv_version=version,
        attempt=0,
        enqueued_at=enqueued_at,
    ).model_dump(exclude={"cv_data"})


def check_environment():
    """Refuse the two setups that fail silently, before anything is written."""
    if not config.DATABASE_URL:
        return "DATABASE_URL is not set (the board lives in Postgres)"
    broker = config.RABBITMQ_URL or ""
    if not broker:
        return "RABBITMQ_URL is not set (publish against localhost through a port-forward)"
    if "svc.cluster.local" in broker:
        return (
            "RABBITMQ_URL still names the in-cluster DNS, which the host cannot resolve - "
            "rebuild it against localhost (see scripts/send-test-job.ps1)"
        )
    return None


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Re-tailor one board column")
    parser.add_argument("--stage", default=DEFAULT_STAGE, help="board column (default: prepare)")
    parser.add_argument(
        "--cv-version",
        required=True,
        help="the master-CV version the re-run is for; part of the idempotency key",
    )
    parser.add_argument("--apply", action="store_true", help="write and publish (default: plan)")
    args = parser.parse_args(argv)

    problem = check_environment()
    if problem:
        print(f"❌ {problem}")
        return 2

    # The board's rows only exist in Postgres, and a `directory` backend would silently write
    # message files nobody consumes - so both backends are pinned here rather than read from env.
    config.DB_BACKEND = "postgres"
    store = db_module.get_db()
    store.ping()
    print(f"📋 postgres ok · stage={args.stage} · cv_version={args.cv_version}")

    cards = fetch_cards(store, args.stage)
    if not cards:
        print(f"✅ nothing to do - no active card in {args.stage}")
        return 0

    publishable = [card for card in cards if (card["description_raw"] or "").strip()]
    skipped = [card for card in cards if card not in publishable]
    print(f"🔎 {len(cards)} active card(s) in {args.stage}:")
    for card in cards:
        why = "" if card in publishable else "  [no description_raw - skipped]"
        print(
            f"   • {card['job_id']}  {card['source']}/{card['external_id']}  "
            f"cv_version {card['cv_version']} -> {args.cv_version}  "
            f"status {card['status']}  cover {card['cover_status'] or '-'}{why}"
        )
    if skipped:
        print("⚠️  a card without a stored description cannot be tailored (the worker would")
        print("    dead-letter the message) - scrape it again and move it to Prepare.")

    if not args.apply:
        print()
        print("dry run - nothing was written and nothing was published (pass --apply)")
        return 0

    task_queue = get_queue(backend="amqp", spec=task_queue_spec())
    cover_queue = get_queue(backend="amqp", spec=cover_queue_spec())

    published = 0
    for card in publishable:
        park_for_reclaim(store, card, args.cv_version)
        enqueued_at = db_module.now_iso()
        task_queue.publish(build_task_message(card, args.cv_version, enqueued_at))
        cover_queue.publish(
            CoverLetterMessage(job_id=card["job_id"], enqueued_at=enqueued_at).model_dump()
        )
        published += 1
        print(f"📤 published cv + cover for {card['job_id']}")

    task_queue.close()
    cover_queue.close()
    print()
    print(f"✅ {published} card(s) queued against master CV {args.cv_version}")
    print("   watch:  kubectl get pods -w")
    print("   logs:   kubectl logs -f deployment/ai-agent-worker --tail=100")
    print("   verify: kubectl exec -i deploy/postgres -- psql -U cvt -d cvt -c \\")
    print("             \"select job_id, cv_version, status from resumes order by updated_at desc limit 5;\"")
    return 0


if __name__ == "__main__":
    sys.exit(main())

