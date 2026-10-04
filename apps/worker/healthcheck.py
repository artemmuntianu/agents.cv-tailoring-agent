"""Container probe (a worker has no HTTP server, so probes are exec-based).

    livenessProbe:  python healthcheck.py --mode liveness   # process responsiveness
    readinessProbe: python healthcheck.py --mode readiness  # heartbeat freshness
    python healthcheck.py --mode amqp                       # broker reachability
    python healthcheck.py --mode render                     # soffice + poppler present
    python healthcheck.py --mode all

Exit code 0 == healthy, 1 == unhealthy (message on stderr/stdout).
"""

import argparse
import json
import os
import socket
import sys
from urllib.parse import urlparse

import config
from utils.logging_setup import heartbeat_age_seconds


def check_heartbeat():
    age = heartbeat_age_seconds()
    if age is None:
        # Written on startup and after every task; missing means the loop never ran.
        return False, "heartbeat file missing"
    if age > config.HEARTBEAT_MAX_AGE_SECONDS:
        return False, f"heartbeat is stale ({int(age)}s > {config.HEARTBEAT_MAX_AGE_SECONDS}s)"
    return True, f"heartbeat age {int(age)}s"


def check_amqp(timeout=5.0):
    try:
        parsed = urlparse(config.RABBITMQ_URL)
        host = parsed.hostname or "localhost"
        port = parsed.port or 5672
        with socket.create_connection((host, port), timeout=timeout):
            pass
        return True, f"amqp reachable at {host}:{port}"
    except Exception as exc:  # noqa: BLE001
        return False, f"amqp unreachable: {exc}"


def check_render():
    from utils.renderer import render_tools_status

    status = render_tools_status()
    missing = [name for name, value in status.items() if not value]
    if missing:
        return False, f"missing render tools: {', '.join(missing)}"
    return True, f"libreoffice={status['libreoffice']} poppler={status['pdftoppm']}"


def check_dirs():
    for directory in (config.TEMP_ROOT, config.QUEUE_DIR):
        try:
            os.makedirs(directory, exist_ok=True)
            probe = os.path.join(directory, ".healthcheck")
            with open(probe, "w", encoding="utf-8") as handle:
                handle.write("ok")
            os.remove(probe)
        except Exception as exc:  # noqa: BLE001
            return False, f"cannot write to {directory}: {exc}"
    return True, "temp/queue dirs writable"


CHECKS = {
    "liveness": [("dirs", check_dirs)],
    "readiness": [("heartbeat", check_heartbeat)],
    "amqp": [("amqp", check_amqp)],
    "render": [("render", check_render)],
}


def run(mode):
    if mode == "all":
        checks = [item for group in CHECKS.values() for item in group]
    else:
        checks = CHECKS.get(mode, CHECKS["liveness"])

    results = {}
    healthy = True
    for name, check in checks:
        try:
            ok, detail = check()
        except Exception as exc:  # noqa: BLE001
            ok, detail = False, f"check raised: {exc}"
        results[name] = {"ok": ok, "detail": detail}
        healthy = healthy and ok

    print(json.dumps({"healthy": healthy, "mode": mode, "checks": results}))
    return 0 if healthy else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="worker healthcheck")
    parser.add_argument(
        "--mode", choices=["liveness", "readiness", "amqp", "render", "all"], default="liveness"
    )
    sys.exit(run(parser.parse_args().mode))
