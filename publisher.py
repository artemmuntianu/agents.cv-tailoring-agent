"""Development stand-in for the Vercel API gateway.

In production the Chrome extension POSTs a batch of vacancies to Vercel, which
publishes one AMQP message per vacancy to `resumes.generate`. Locally the
extension/Vercel do not exist, so this script publishes the exact same payload:

    python publisher.py --all                          # every jd_*.txt in artifacts/input
    python publisher.py --jd artifacts/input/jd_1.txt
    python publisher.py --jd jd.txt --user-id <uuid> --attach-cv-data
    python publisher.py --payload payload.json         # raw JSON passthrough

Works against both backends (QUEUE_BACKEND=directory|amqp), so the whole worker
loop can be exercised offline or against a local RabbitMQ.
"""

import argparse
import json
import sys

if hasattr(sys.stdout, "reconfigure"):
    # Windows consoles default to cp1252 and choke on emoji output.
    sys.stdout.reconfigure(encoding="utf-8")
from datetime import UTC, datetime

import config
from main import find_job_descriptions, jd_id_from_path
from utils.docx_mutator import load_cv_data
from utils.logging_setup import setup_logging
from utils.messaging import get_queue


def build_payload(jd_path, user_id=None, attach_cv_data=False, cv_data=None):
    with open(jd_path, encoding="utf-8") as handle:
        description = handle.read()

    external_id = jd_id_from_path(jd_path)
    payload = {
        "job_id": f"{external_id}-{int(datetime.now(UTC).timestamp())}",
        "user_id": user_id,
        "external_id": external_id,
        "title": "",
        "company": "",
        "source_url": None,
        "description_raw": description,
        "cv_version": "v1",
        "attempt": 0,
        "enqueued_at": datetime.now(UTC).isoformat(),
    }
    if attach_cv_data and cv_data is not None:
        payload["cv_data"] = cv_data
    return payload


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Publish resume.generate tasks (dev gateway)")
    parser.add_argument("--jd", action="append", default=[], help="path to a jd_*.txt file")
    parser.add_argument("--all", action="store_true", help="publish every jd_*.txt in the input dir")
    parser.add_argument("--payload", help="publish a raw JSON payload from this file")
    parser.add_argument("--user-id", default=None)
    parser.add_argument(
        "--attach-cv-data",
        action="store_true",
        help="embed cv_data.json in the message (otherwise the worker loads it)",
    )
    parser.add_argument(
        "--queue-backend", choices=["directory", "amqp"], default=None
    )
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    if args.queue_backend:
        config.QUEUE_BACKEND = args.queue_backend
    setup_logging()

    queue = get_queue()

    if args.payload:
        with open(args.payload, encoding="utf-8") as handle:
            payloads = [json.load(handle)]
    else:
        jd_paths = list(args.jd)
        if args.all:
            jd_paths.extend(find_job_descriptions(config.INPUT_DIR))
        if not jd_paths:
            jd_paths = find_job_descriptions(config.INPUT_DIR)
        if not jd_paths:
            print(f"❌ No jd_*.txt files found in {config.INPUT_DIR}")
            return 1

        cv_data = None
        if args.attach_cv_data:
            cv_data = load_cv_data()
        payloads = [
            build_payload(path, args.user_id, args.attach_cv_data, cv_data)
            for path in jd_paths
        ]

    for payload in payloads:
        queue.publish(payload)
        print(f"📤 published task external_id={payload.get('external_id')} "
              f"job_id={payload.get('job_id')} -> {config.QUEUE_NAME} "
              f"({config.QUEUE_BACKEND})")

    print(f"✅ Published {len(payloads)} message(s).")
    queue.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
