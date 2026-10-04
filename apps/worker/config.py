"""Central configuration.

Every value is environment-overridable, so the same code base runs the broker
consumer in Kubernetes (`python worker.py`) and the hermetic test suite. No provider
SDK is imported here, so this module stays importable with only the base
requirements installed (see `.env.example`).
"""

import os

from dotenv import load_dotenv

load_dotenv()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SERVICE_NAME = os.getenv("SERVICE_NAME", "cv-tailoring-worker")


# --------------------------------------------------------------------------- #
# small env helpers
# --------------------------------------------------------------------------- #
def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "y", "on")


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw.strip())
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw.strip())
    except ValueError:
        return default


def _env_list(name: str, default):
    """Path-list helper: splits on os.pathsep (used for binary search paths)."""
    raw = os.getenv(name)
    if not raw:
        return list(default)
    return [item.strip() for item in raw.split(os.pathsep) if item.strip()]


def _env_csv(name: str, default):
    """Comma-separated list helper.

    Model names must NOT use os.pathsep: it is ':' on Linux and ';' on Windows,
    so a Helm-provided value would parse differently in the cluster than on a
    developer machine.
    """
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return list(default)
    return [item.strip() for item in raw.split(",") if item.strip()]


# --------------------------------------------------------------------------- #
# LLM (Google Gemini)
# --------------------------------------------------------------------------- #
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

# ⚠️  The values below are PLACEHOLDERS. Before deploying, replace them with the
# model IDs your API key can actually access (`scripts/check_models.py` prints
# them). A wrong ID fails with 400 INVALID_ARGUMENT, which is not retryable, so
# every task would burn its attempts and land in the DLQ. The worker therefore
# validates MODEL_NAME against `models.list()` during preflight and refuses to
# start if the model does not exist.
MODEL_NAME = os.getenv("MODEL_NAME", "gemini-3.5-flash")

# Ordered fallback list (top = most preferred), COMMA-separated. The retry layer
# advances to the next model when the current one hits its 429 rate-limit retry
# ceiling, or when its daily quota (RPD) is exhausted.
PREFERRED_MODELS = _env_csv("PREFERRED_MODELS", [
    "gemini-3.5-flash",
    "gemini-3.6-flash",
    "gemini-3.7-flash",
    "gemini-3.8-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
])

MAX_REVISIONS = _env_int("MAX_REVISIONS", 3)
RENDER_DPI = _env_int("RENDER_DPI", 70)

# --------------------------------------------------------------------------- #
# Backoff / retry
# --------------------------------------------------------------------------- #
BACKOFF_INITIAL_DELAY = _env_float("BACKOFF_INITIAL_DELAY", 2.0)
BACKOFF_FACTOR = _env_float("BACKOFF_FACTOR", 2.0)
BACKOFF_MAX_DELAY = _env_float("BACKOFF_MAX_DELAY", 60.0)
BACKOFF_MAX_RETRIES = _env_int("BACKOFF_MAX_RETRIES", 5)

# How many times a queue message may be redelivered before it is parked in the
# dead-letter queue (poison-message protection).
MAX_ATTEMPTS = _env_int("MAX_ATTEMPTS", 3)
# How many times the tailoring answer is sent back to the model when the deterministic check finds
# an invented metric or a technology nothing backs (`apps/worker/agent/verification.py::self_heal_replacements`).
# Each retry is one extra model call, so this is a spend ceiling as much as a quality dial: the loop
# stops at the first clean answer, and a task that never gets one still ships *without* the
# offending replacements rather than with them.
MAX_FABRICATION_RETRIES = _env_int("MAX_FABRICATION_RETRIES", 3)

# When a model runs out of daily quota we either wait interactively (a human is
# at the console) or hand the task back to the queue for a later retry (pod).
# `auto` => interactive only when stdin is a TTY.
_quota_wait_raw = os.getenv("INTERACTIVE_QUOTA_WAIT", "auto").strip().lower()
if _quota_wait_raw in ("auto", ""):
    INTERACTIVE_QUOTA_WAIT = None
else:
    INTERACTIVE_QUOTA_WAIT = _quota_wait_raw in ("1", "true", "yes", "y", "on")


# --------------------------------------------------------------------------- #
# Local filesystem layout
# --------------------------------------------------------------------------- #
ARTIFACTS_DIR = os.getenv("ARTIFACTS_DIR", os.path.join(BASE_DIR, "artifacts"))
INPUT_DIR = os.getenv("INPUT_DIR", os.path.join(ARTIFACTS_DIR, "input"))
OUTPUT_DIR = os.getenv("OUTPUT_DIR", os.path.join(ARTIFACTS_DIR, "output"))
TEMP_DIR = os.getenv("TEMP_DIR", os.path.join(ARTIFACTS_DIR, "temp"))
QUEUE_DIR = os.getenv("QUEUE_DIR", os.path.join(ARTIFACTS_DIR, "queue"))

# Root for per-job working directories in worker mode.
TEMP_ROOT = os.getenv("TEMP_ROOT", TEMP_DIR)

MASTER_CV_FILENAME = os.getenv("MASTER_CV_FILENAME", "cv.docx")
CV_DATA_PATH = os.getenv("CV_DATA_PATH", os.path.join(ARTIFACTS_DIR, "cv_data.json"))

# Persisted model availability state (JSON, local 'file' backend only).
MODEL_STATE_FILE = os.getenv(
    "MODEL_STATE_FILE", os.path.join(BASE_DIR, "model_state.json")
)
# How long (hours) a model flagged unavailable is skipped before it is retried.
MODEL_UNAVAILABLE_TTL_HOURS = _env_int("MODEL_UNAVAILABLE_TTL_HOURS", 24)

# --------------------------------------------------------------------------- #
# Backend selection (local vs cloud)
# --------------------------------------------------------------------------- #
# queue:       directory | amqp
# db:          local | postgres
# model_state: file | postgres
QUEUE_BACKEND = os.getenv("QUEUE_BACKEND", "directory").strip().lower()
DB_BACKEND = os.getenv("DB_BACKEND", "local").strip().lower()
MODEL_STATE_BACKEND = os.getenv("MODEL_STATE_BACKEND", "file").strip().lower()

# --------------------------------------------------------------------------- #
# RabbitMQ / AMQP
# --------------------------------------------------------------------------- #
# Either set RABBITMQ_URL directly, or set the parts and let the URL be
# composed. Composing is preferable in Kubernetes: the username/password can then
# come from the *same* Secret the KEDA TriggerAuthentication reads, so the broker
# password exists in one place only.
RABBITMQ_HOST = os.getenv("RABBITMQ_HOST", "localhost")
RABBITMQ_PORT = _env_int("RABBITMQ_PORT", 5672)
RABBITMQ_USERNAME = os.getenv("RABBITMQ_USERNAME", "guest")
RABBITMQ_PASSWORD = os.getenv("RABBITMQ_PASSWORD", "")
RABBITMQ_VHOST = os.getenv("RABBITMQ_VHOST", "/")


def _rabbitmq_url() -> str:
    explicit = os.getenv("RABBITMQ_URL")
    if explicit:
        return explicit
    if RABBITMQ_PASSWORD:
        vhost = "%2F" if RABBITMQ_VHOST in ("/", "") else RABBITMQ_VHOST
        return (
            f"amqp://{RABBITMQ_USERNAME}:{RABBITMQ_PASSWORD}"
            f"@{RABBITMQ_HOST}:{RABBITMQ_PORT}/{vhost}"
        )
    return "amqp://guest:guest@localhost:5672/%2F"


RABBITMQ_URL = _rabbitmq_url()
RABBITMQ_MANAGEMENT_URL = os.getenv(
    "RABBITMQ_MANAGEMENT_URL", "http://localhost:15672"
)
QUEUE_NAME = os.getenv("QUEUE_NAME", "resumes.generate")
QUEUE_DLX = os.getenv("QUEUE_DLX", f"{QUEUE_NAME}.dlx")
QUEUE_DLQ = os.getenv("QUEUE_DLQ", f"{QUEUE_NAME}.dlq")
QUEUE_RETRY_TTL_MS = _env_int("QUEUE_RETRY_TTL_MS", 300000)
# A second, independent queue. A cover letter is generated on demand for one card, so it must
# neither wait behind a tailoring backlog nor wake the tailoring workers: each queue has its
# own ScaledObject, and the four places that declare the topology share these names.
COVER_QUEUE_NAME = os.getenv("COVER_QUEUE_NAME", "resumes.cover")
COVER_QUEUE_DLX = os.getenv("COVER_QUEUE_DLX", f"{COVER_QUEUE_NAME}.dlx")
COVER_QUEUE_DLQ = os.getenv("COVER_QUEUE_DLQ", f"{COVER_QUEUE_NAME}.dlq")
# The third queue: the extension's application-form filler (`apply.py`). One message per
# *rendered* form (`job_id`, `schema_hash`, the annotated form), answered with a plan the
# extension applies to that DOM. Its own ScaledObject and its own four declarers for the same
# reason as the cover queue - and it deliberately carries no generated documents: the cover
# letter and the tailored PDF are inserted locally, from the board.
APPLICATION_QUEUE_NAME = os.getenv("APPLICATION_QUEUE_NAME", "applications.draft")
APPLICATION_QUEUE_DLX = os.getenv("APPLICATION_QUEUE_DLX", f"{APPLICATION_QUEUE_NAME}.dlx")
APPLICATION_QUEUE_DLQ = os.getenv("APPLICATION_QUEUE_DLQ", f"{APPLICATION_QUEUE_NAME}.dlq")
# The fourth queue: a hand-edited deliverable (`rerender.py`). The operator downloads the tailored
# DOCX, fixes what the model could not, and uploads it back; the bytes are stored in
# `resume_docx_update` and this queue asks for the new PDF. Its own ScaledObject and its own four
# declarers, for the same reason as the cover queue: rendering must not wait behind tailoring.
RERENDER_QUEUE_NAME = os.getenv("RERENDER_QUEUE_NAME", "resumes.rerender")
RERENDER_QUEUE_DLX = os.getenv("RERENDER_QUEUE_DLX", f"{RERENDER_QUEUE_NAME}.dlx")
RERENDER_QUEUE_DLQ = os.getenv("RERENDER_QUEUE_DLQ", f"{RERENDER_QUEUE_NAME}.dlq")
# The upload cap, mirrored by the board (`apps/backoffice/src/lib/docxUpload.ts`): a DOCX is a few
# hundred kilobytes in practice, and both ends of the wire have to refuse the same way.
MAX_DOCX_UPLOAD_BYTES = _env_int("MAX_DOCX_UPLOAD_BYTES", 20 * 1024 * 1024)
PREFETCH_COUNT = _env_int("PREFETCH_COUNT", 1)
CONSUMER_POLL_INTERVAL = _env_float("CONSUMER_POLL_INTERVAL", 2.0)
# AMQP heartbeat (seconds), 0 disables it. It MUST exceed the longest task: the
# pika BlockingConnection cannot service heartbeats while the graph runs, so the
# broker drops the connection two heartbeats in ("missed heartbeats from client,
# timeout: 60s"), requeues the unacked message and the whole task restarts - which
# is what a rate-limited Gemini turn (backoff up to 60s x 5) triggers. RabbitMQ's
# own `consumer_timeout` remains the backstop for a genuinely dead consumer.
AMQP_HEARTBEAT_SECONDS = _env_int("AMQP_HEARTBEAT_SECONDS", 600)
HEARTBEAT_FILE = os.getenv("HEARTBEAT_FILE", os.path.join(TEMP_ROOT, "heartbeat"))
HEARTBEAT_MAX_AGE_SECONDS = _env_int("HEARTBEAT_MAX_AGE_SECONDS", 300)

# --------------------------------------------------------------------------- #
# Scheduled vacancy intake (`apps/worker/scout/`)
# --------------------------------------------------------------------------- #
# The board queues tailoring only when the operator drags a card into Prepare, so an intake
# that just creates cards is free: no Gemini call, no broker round trip. The scout is that
# intake for feeds nobody browses by hand.
#
# A feed URL is the only thing a site needs here: `scout.sources` routes it to the parser of
# the host it belongs to (`apps/worker/scout/parsers/<site>.py`), which is also what decides the card's
# `resumes.source` slug. Adding a site is a parser module plus a URL in this list.
SCOUT_FEEDS = _env_csv(
    "SCOUT_FEEDS",
    [
        "https://jobs.dou.ua/vacancies/feeds/?remote&category=.NET&exp=5plus",
        "https://jobs.dou.ua/vacancies/feeds/?remote&category=Engineering%20Manager",
        "https://jobs.dou.ua/vacancies/feeds/?remote&category=Architect",
        # Djinni's RSS is its listing URL with `/jobs/rss/` instead of `/jobs/`. One feed carries
        # the whole keyword set (dotnet, lead, python, javascript, node, cto, engineering manager,
        # architect) at $5000+, 5+ years, remote, English pre-intermediate and up.
        "https://djinni.co/jobs/rss/?search_type=basic-search&primary_keyword=.NET"
        "&primary_keyword=Lead&primary_keyword=Python&primary_keyword=JavaScript"
        "&primary_keyword=Node.js&primary_keyword=CTO&primary_keyword=Engineering%20Manager"
        "&primary_keyword=Architect&salary=5000&exp_level=5y&employment=remote"
        "&english_level=pre&english_level=intermediate&english_level=upper",
        # Landing.Jobs publishes **Atom**, not RSS, and its one document carries every vacancy open
        # on the board - there is no per-keyword search to tune, which is exactly what the age rule
        # below is for. The URL's host picks its parser and the `landing-jobs` slug.
        "https://landing.jobs/feed",
    ],
)
# There is deliberately no `SCOUT_SOURCE`: a card's site slug is a property of its *feed*, not of
# the run, so `scout.sources` derives it from the feed's host - the same rule the browser scrape
# applies to the page's URL, which is what keeps the two writers on one card.
# Whose rows the scout creates - a provisioned `app_users.id`. It matters: the worker's claim
# looks the vacancy up by `(user_id, source, external_id, cv_version)`, and the board publishes
# a drag with the row's own owner, so a different owner here would fork a second row.
SCOUT_USER_ID = os.getenv("SCOUT_USER_ID", "")
# 0 = every new vacancy of the run (a feed can be long, and a new card costs nothing until the
# operator drags it). Kept as a knob only so a runaway feed can be capped without a code change.
SCOUT_MAX_PER_RUN = _env_int("SCOUT_MAX_PER_RUN", 0)
# A feed is a window, not a stream: it keeps returning what it published weeks ago, and an old
# posting is a dead one. A vacancy the feed itself dated further back than this is not scraped at
# all (0 disables the rule). A vacancy whose feed carries no usable date is kept - the rule judges
# what a feed *said*, never what it omitted (`apps/worker/scout/policy.py`).
SCOUT_MAX_AGE_DAYS = _env_int("SCOUT_MAX_AGE_DAYS", 14)
SCOUT_TIMEOUT_SECONDS = _env_int("SCOUT_TIMEOUT_SECONDS", 20)
# `telegram` sends one message per new vacancy (scheduled sources only - a browser scrape never
# notifies); `none` keeps the intake silent while still creating the cards.
SCOUT_NOTIFY = os.getenv("SCOUT_NOTIFY", "telegram").strip().lower()
SCOUT_TELEGRAM_TOKEN = os.getenv("SCOUT_TELEGRAM_TOKEN", "")
SCOUT_TELEGRAM_CHAT_ID = os.getenv("SCOUT_TELEGRAM_CHAT_ID", "")
CV_VERSION = os.getenv("CV_VERSION", "v1")

# --------------------------------------------------------------------------- #
# The internal process ledger (`apps/worker/utils/process_runs.py`)
# --------------------------------------------------------------------------- #
# A killed pod leaves its run row `running`; the next run of the same job retires
# anything older than this as `aborted`, so the board's Processes window never shows
# a job that is actually dead. Keep it above the longest run (the jobs'
# activeDeadlineSeconds is 600).
PROCESS_RUN_STALE_HOURS = _env_int("PROCESS_RUN_STALE_HOURS", 24)

# --------------------------------------------------------------------------- #
# The inactivity archive (`python -m archiver`)
# --------------------------------------------------------------------------- #
# A card in one of these columns that no *operator action* has touched for
# `AUTO_ARCHIVE_AFTER_DAYS` days is refused in place automatically. This is the
# housekeeping half of the intake: it never moves a card, never writes
# `resumes.status` and never queues a message - it only closes applications nobody is
# working on any more, with the same actor/reason/history rules a manual refusal keeps.
AUTO_ARCHIVE_STAGES = _env_csv("AUTO_ARCHIVE_STAGES", ["applied"])
AUTO_ARCHIVE_AFTER_DAYS = _env_int("AUTO_ARCHIVE_AFTER_DAYS", 10)
# The actor vocabulary is the DB CHECK (`Candidate` | `Company`); "Company" is the
# honest answer for silence. The reason must be 1..500 characters.
AUTO_ARCHIVE_ACTOR = os.getenv("AUTO_ARCHIVE_ACTOR", "Company")
AUTO_ARCHIVE_REASON = os.getenv("AUTO_ARCHIVE_REASON", "No response")
# Safety cap: a first sweep of a board that was never swept must not refuse a whole
# column in one run.
AUTO_ARCHIVE_MAX_PER_RUN = _env_int("AUTO_ARCHIVE_MAX_PER_RUN", 50)

# Keep per-job temp dirs (PDFs, page PNGs) after a task for debugging.
KEEP_TEMP_DIRS = _env_bool("KEEP_TEMP_DIRS", False)

# --------------------------------------------------------------------------- #
# Postgres
# --------------------------------------------------------------------------- #
DATABASE_URL = os.getenv("DATABASE_URL", "")
DATABASE_SSLMODE = os.getenv("DATABASE_SSLMODE", "require")

# A *pooled* connection (pgbouncer in transaction mode, e.g. a managed
# Postgres pooler on port 6543) does not support server-side prepared
# statements - psycopg would fail on the second execution of the same
# statement. Disabled by default; set DB_PREPARE_STATEMENTS=true for a
# direct/session connection.
DB_PREPARE_STATEMENTS = _env_bool("DB_PREPARE_STATEMENTS", False)
DB_PREPARE_THRESHOLD = _env_int("DB_PREPARE_THRESHOLD", 5)
# Shows up in pg_stat_activity, which makes the runbook queries useful.
DB_APPLICATION_NAME = os.getenv("DB_APPLICATION_NAME", "cv-tailoring-worker")
# Artifacts are stored locally: everything lives under ARTIFACTS_DIR, which is
# a PersistentVolumeClaim in Kubernetes (`/data`) and `artifacts/` for the CLI.
# Object keys are flattened to a file name by `utils.storage.LocalStorage`.
OUTPUT_KEY_PREFIX = os.getenv("OUTPUT_KEY_PREFIX", "tailored")

# --------------------------------------------------------------------------- #
# Logging
# --------------------------------------------------------------------------- #
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
LOG_FORMAT = os.getenv("LOG_FORMAT", "text").strip().lower()  # text | json

# --------------------------------------------------------------------------- #
# External binaries (LibreOffice + poppler)
# --------------------------------------------------------------------------- #
LIBREOFFICE_PATHS = _env_list("LIBREOFFICE_PATHS", [
    "/usr/bin/soffice",
    "/usr/bin/libreoffice",
    "/opt/libreoffice/program/soffice",
    r"C:\Program Files\LibreOffice\program\soffice.exe",
    r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    "soffice",
    "libreoffice",
])


def _default_poppler_path():
    """Poppler is on PATH inside the container; keep the Windows path for dev."""
    explicit = os.getenv("POPPLER_PATH")
    if explicit:
        return explicit
    windows_candidate = r"C:\Tools\poppler\poppler-26.07.0\Library\bin"
    if os.path.isdir(windows_candidate):
        return windows_candidate
    return None


POPPLER_PATH = _default_poppler_path()

