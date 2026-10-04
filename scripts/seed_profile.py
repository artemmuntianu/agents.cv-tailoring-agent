#!/usr/bin/env python
"""Write a candidate-facts JSON file into the operator's `application_profile` row.

    python scripts/seed_profile.py --file artifacts/candidate_profile.json --user <uuid>
    python scripts/seed_profile.py --file artifacts/candidate_profile.json --dry-run

The facts live in Postgres (one jsonb row per operator) rather than in a file, because the board
edits them on the host while the workers read them in the cluster. This is the way to load a whole
answer set at once: the extension's editor only shows the short fields, so the standing answers
(the recruiter answers that ground the CV, the letter and the form prompts) have no UI.

The payload runs through `utils.candidate.sanitize()` first - the same function the prompts' input
goes through - so what lands in the database is exactly what a model may see, and a value that hits
a cap is reported instead of being silently cut.

A host-side run talks to the cluster's Postgres through `kubectl port-forward svc/postgres 5432:5432`
and needs `DATABASE_SSLMODE=disable` (the dev Postgres serves plain TCP, while `config` defaults to
`require`).
"""

import argparse
import json
import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    # Windows consoles default to cp1252 and choke on non-ASCII output.
    sys.stdout.reconfigure(encoding="utf-8")

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# The worker app lives under apps/worker after the monorepo move; its
# packages (config, agent, utils) are importable only from there.
APP_ROOT = os.path.join(REPO_ROOT, "apps", "worker")
if APP_ROOT not in sys.path:
    sys.path.insert(0, APP_ROOT)

from utils import candidate as candidate_module  # noqa: E402
from utils import db as db_module  # noqa: E402

DEFAULT_FILE = os.path.join("artifacts", "candidate_profile.json")


def _truncations(raw, clean):
    """Values the caps shortened, as `(question, written, kept)` - a silent cut is a data bug."""
    cut = []
    for section in (None, "standing_answers"):
        written = raw if section is None else (raw.get(section) or {})
        kept = clean if section is None else (clean.get(section) or {})
        for key, value in kept.items():
            if not isinstance(value, str):
                # The nested `standing_answers` document is compared in its own pass.
                continue
            original = str(written.get(key, "")).strip()
            if len(original) > len(value):
                cut.append((key, len(original), len(value)))
    return cut


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="seed the candidate facts row")
    parser.add_argument("--file", default=DEFAULT_FILE, help=f"JSON facts file ({DEFAULT_FILE})")
    parser.add_argument("--user", default="", help="operator user id (the row's primary key)")
    parser.add_argument("--dry-run", action="store_true", help="print what would be stored")
    args = parser.parse_args(argv)

    try:
        with open(args.file, encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, ValueError) as exc:
        print(f"❌ could not read {args.file}: {exc}")
        return 2

    clean = candidate_module.sanitize(raw)
    if not clean:
        print("❌ nothing survived sanitizing - are the fact keys spelled as in apps/worker/utils/candidate.py?")
        return 2

    answers = clean.get("standing_answers") or {}
    facts = [key for key, _label in candidate_module.FACTS if clean.get(key)]
    digest = candidate_module.digest(clean)
    print(f"facts:   {len(facts)} of {len(candidate_module.FACTS)} ({', '.join(facts)})")
    print(f"answers: {len(answers)} (digest {len(digest)} chars, longest answer "
          f"{max((len(v) for v in answers.values()), default=0)} chars)")
    for question, written, kept in _truncations(raw, clean):
        print(f"⚠️  truncated at {kept} chars: {question} (was {written})")

    if args.dry_run:
        print(json.dumps(clean, ensure_ascii=False, indent=2))
        return 0
    if not args.user:
        print("❌ --user is required to write (or use --dry-run to inspect the payload)")
        return 2

    try:
        db_module.get_db().upsert_application_profile(args.user, clean)
    except Exception as exc:  # noqa: BLE001 - one clear failure beats a traceback
        print(f"❌ could not write the profile row: {exc}")
        return 2
    print(f"✅ candidate facts written for user {args.user} (backend "
          f"{db_module.get_db().backend})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
