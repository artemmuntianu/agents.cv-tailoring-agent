"""Central configuration.

Every value is environment-overridable so the exact same code base runs
- locally as a CLI batch tool (`python main.py`), and
- in Kubernetes as a RabbitMQ consumer (`python worker.py`).

Local defaults are unchanged; cloud behaviour is switched on purely by env vars
(see `.env.example`). No provider SDK is imported here, so this module stays
importable with only the base requirements installed.
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
# storage:     local | supabase
# db:          local | postgres
# model_state: file | postgres
QUEUE_BACKEND = os.getenv("QUEUE_BACKEND", "directory").strip().lower()
STORAGE_BACKEND = os.getenv("STORAGE_BACKEND", "local").strip().lower()
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
PREFETCH_COUNT = _env_int("PREFETCH_COUNT", 1)
CONSUMER_POLL_INTERVAL = _env_float("CONSUMER_POLL_INTERVAL", 2.0)
HEARTBEAT_FILE = os.getenv("HEARTBEAT_FILE", os.path.join(TEMP_ROOT, "heartbeat"))
HEARTBEAT_MAX_AGE_SECONDS = _env_int("HEARTBEAT_MAX_AGE_SECONDS", 300)

# Keep per-job temp dirs (PDFs, page PNGs) after a task for debugging.
KEEP_TEMP_DIRS = _env_bool("KEEP_TEMP_DIRS", False)

# --------------------------------------------------------------------------- #
# Postgres / Supabase
# --------------------------------------------------------------------------- #
DATABASE_URL = os.getenv("DATABASE_URL", "")
DATABASE_SSLMODE = os.getenv("DATABASE_SSLMODE", "require")

# Supabase's *pooled* connection (pgbouncer, port 6543, transaction mode) does
# not support server-side prepared statements - psycopg would start failing on
# the second execution of the same statement. They are therefore disabled by
# default; set DB_PREPARE_STATEMENTS=true when pointing at a direct/session
# connection (port 5432).
DB_PREPARE_STATEMENTS = _env_bool("DB_PREPARE_STATEMENTS", False)
DB_PREPARE_THRESHOLD = _env_int("DB_PREPARE_THRESHOLD", 5)
# Shows up in pg_stat_activity, which makes the runbook queries useful.
DB_APPLICATION_NAME = os.getenv("DB_APPLICATION_NAME", "cv-tailoring-worker")
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
SUPABASE_BUCKET = os.getenv("SUPABASE_BUCKET", "resumes")
# Object keys inside the bucket.
SUPABASE_MASTER_CV_KEY = os.getenv("SUPABASE_MASTER_CV_KEY", "master/cv.docx")
SUPABASE_CV_DATA_KEY = os.getenv("SUPABASE_CV_DATA_KEY", "master/cv_data.json")
SUPABASE_OUTPUT_PREFIX = os.getenv("SUPABASE_OUTPUT_PREFIX", "tailored")
SUPABASE_URL_TTL_SECONDS = _env_int("SUPABASE_URL_TTL_SECONDS", 604800)

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

