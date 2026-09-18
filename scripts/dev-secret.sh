#!/usr/bin/env bash
# Create the worker's Kubernetes Secret from the local .env (secrets never land
# in git or in Helm values).
#
#   make dev-secret
#   NAMESPACE=staging SECRET_NAME=cv-tailoring-secrets ./scripts/dev-secret.sh
set -euo pipefail

NAMESPACE="${NAMESPACE:-default}"
SECRET_NAME="${SECRET_NAME:-cv-tailoring-secrets}"
ENV_FILE="${ENV_FILE:-.env}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "❌ ${ENV_FILE} not found. Copy .env.example to .env and fill it in." >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "${ENV_FILE}"; set +a

: "${GEMINI_API_KEY:?GEMINI_API_KEY must be set in ${ENV_FILE}}"
: "${DATABASE_URL:?DATABASE_URL must be set in ${ENV_FILE}}"
: "${SUPABASE_URL:?SUPABASE_URL must be set in ${ENV_FILE}}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY must be set in ${ENV_FILE}}"
RABBITMQ_URL="${RABBITMQ_URL:-amqp://cvt:cvt@rabbitmq.${NAMESPACE}.svc.cluster.local:5672/%2F}"

kubectl create secret generic "${SECRET_NAME}" \
  --namespace "${NAMESPACE}" \
  --from-literal=GEMINI_API_KEY="${GEMINI_API_KEY}" \
  --from-literal=DATABASE_URL="${DATABASE_URL}" \
  --from-literal=SUPABASE_URL="${SUPABASE_URL}" \
  --from-literal=SUPABASE_SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY}" \
  --from-literal=RABBITMQ_URL="${RABBITMQ_URL}" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "✅ Secret ${SECRET_NAME} applied in namespace ${NAMESPACE}"
