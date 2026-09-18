# AI worker image: Python + LangGraph + python-docx + LibreOffice + poppler.
# The system binaries are the reason this cannot run on Vercel serverless.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# LibreOffice (DOCX -> PDF) + poppler (PDF -> PNG).
#
# FONTS MATTER: the master CV uses Calibri / Calibri Light, which Windows has but
# Debian does not. Without metric-compatible replacements LibreOffice silently
# substitutes and the rendered PDF (line breaks, page breaks) differs from Word -
# which changes what the Gemini Vision layout check sees. Carlito/Caladea are
# metrically identical to Calibri/Cambria, and Liberation matches Arial/Times.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libreoffice-writer \
        libreoffice-core \
        poppler-utils \
        fonts-liberation \
        fonts-dejavu-core \
        fonts-crosextra-carlito \
        fonts-crosextra-caladea \
        tini \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin appuser

WORKDIR /app

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY --chown=appuser:appuser . .

RUN mkdir -p /app/artifacts /tmp/cvt && chown -R appuser:appuser /app /tmp/cvt

USER appuser
ENV HOME=/home/appuser \
    TEMP_ROOT=/tmp/cvt \
    QUEUE_DIR=/tmp/cvt/queue \
    ARTIFACTS_DIR=/app/artifacts

# Warm the LibreOffice user profile at build time to cut pod cold start.
RUN soffice --headless --terminate_after_init >/dev/null 2>&1 || true

# Cluster defaults: consume RabbitMQ, persist to Supabase. Overridable at deploy.
ENV QUEUE_BACKEND=amqp \
    DB_BACKEND=postgres \
    STORAGE_BACKEND=supabase \
    MODEL_STATE_BACKEND=postgres \
    LOG_FORMAT=json

# tini reaps zombies and forwards SIGTERM, so the in-flight task can be acked.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python", "worker.py"]
