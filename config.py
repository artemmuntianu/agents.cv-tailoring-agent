import os

GEMINI_API_KEY = "REDACTED_BY_OPENCLAW"
if GEMINI_API_KEY:
    os.environ["GEMINI_API_KEY"] = GEMINI_API_KEY

MODEL_NAME = "gemini-3.5-flash"

# Persisted model availability state (JSON). Survives across runs so we resume
# from the last known-good model and skip models that recently failed.
MODEL_STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "model_state.json")
# How long (hours) a model flagged unavailable is skipped before it is retried.
MODEL_UNAVAILABLE_TTL_HOURS = 24

# Ordered fallback list (top = most preferred). The retry layer advances to the
# next model when the current one hits its 429 rate-limit retry ceiling, or when
# its daily quota (RPD) is exhausted.
PREFERRED_MODELS = [
    "gemini-3.5-flash",
    "gemini-3.6-flash",
    "gemini-3.7-flash",
    "gemini-3.8-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
]
MAX_REVISIONS = 3
RENDER_DPI = 70

BACKOFF_INITIAL_DELAY = 2.0
BACKOFF_FACTOR = 2.0
BACKOFF_MAX_DELAY = 60.0
BACKOFF_MAX_RETRIES = 5

LIBREOFFICE_PATHS = [
    r"C:\Program Files\LibreOffice\program\soffice.exe",
    r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    "soffice",
    "libreoffice"
]

POPPLER_PATH = r"C:\Tools\poppler\poppler-26.07.0\Library\bin"
