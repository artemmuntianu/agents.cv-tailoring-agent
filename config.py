import os

MODEL_NAME = "gemini-2.5-flash"
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
