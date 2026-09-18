#!/usr/bin/env bash
# Create the three Secrets a production release expects, from .env (or the
# current environment). Idempotent: safe to re-run after rotating a value.
#
#   NAMESPACE=default ./scripts/prod-secrets.sh
#
# 1. rabbitmq-password     -> consumed by the Bitnami RabbitMQ chart (key: rabbitmq-password)
# 2. rabbitmq-credentials  -> consumed by KEDA's TriggerAuthentication
#                             (keys: rabbitmq-username, rabbitmq-password, rabbitmq-url)
# 3. cv-tailoring-secrets  -> consumed by the worker Pod (existingSecret)
#
# Values are never written to disk or to git: they go straight into the cluster.
set -euo pipefail

NAMESPACE="${NAMESPACE:-default}"
BROKER_SECRET="${BROKER_SECRET:-rabbitmq-password}"
KEDA_SECRET="${KEDA_SECRET:-rabbitmq-credentials}"
WORKER_SECRET="${WORKER_SECRET:-cv-tailoring-secrets}"
BROKER_HOST="${BROKER_HOST:-rabbitmq.${NAMESPACE}.svc.cluster.local}"
ENV_FILE="${ENV_FILE:-.env}"

if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  set -a; source "${ENV_FILE}"; set +a
fi

require() {
  if [[ -z "${!1:-}" ]]; then
    echo "❌ ${1} is not set (add it to ${ENV_FILE} or export it)" >&2
    exit 1
  fi
}

require GEMINI_API_KEY
require DATABASE_URL
require SUPABASE_URL
require SUPABASE_SERVICE_ROLE_KEY

RABBITMQ_USER="${RABBITMQ_USER:-cvt}"
RABBITMQ_PASSWORD="${RABBITMQ_PASSWORD:-}"
if [[ -z "${RABBITMQ_PASSWORD}" ]]; then
  # Broker-to-worker traffic only: generate rather than invent a weak default.
  RABBITMQ_PASSWORD="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)"
  echo "ℹ️  generated a RabbitMQ password (set RABBITMQ_PASSWORD to pin your own)"
fi

# amqp://user:pass@host:5672/%2F  -> the path is the vhost '/'
RABBITMQ_URL="${RABBITMQ_URL:-amqp://${RABBITMQ_USER}:${RABBITMQ_PASSWORD}@${BROKER_HOST}:5672/%2F}"

case "${RABBITMQ_PASSWORD}" in
  *[!A-Za-z0-9._~-]*)
    echo "⚠️  Password contains characters that must be URL-encoded inside an AMQP URL." >&2
    echo "    Prefer [A-Za-z0-9._~-] or set RABBITMQ_URL explicitly." >&2
    ;;
esac

apply() { kubectl apply -n "${NAMESPACE}" -f -; }

# --- 1. broker password (Bitnami RabbitMQ chart) --------------------------- #
kubectl create secret generic "${BROKER_SECRET}" -n "${NAMESPACE}" \
  --from-literal=rabbitmq-password="${RABBITMQ_PASSWORD}" \
  --dry-run=client -o yaml | apply

# --- 2. KEDA scaler credentials -------------------------------------------- #
kubectl create secret generic "${KEDA_SECRET}" -n "${NAMESPACE}" \
  --from-literal=rabbitmq-username="${RABBITMQ_USER}" \
  --from-literal=rabbitmq-password="${RABBITMQ_PASSWORD}" \
  --from-literal=rabbitmq-url="${RABBITMQ_URL}" \
  --dry-run=client -o yaml | apply

# --- 3. worker credentials -------------------------------------------------- #
kubectl create secret generic "${WORKER_SECRET}" -n "${NAMESPACE}" \
  --from-literal=GEMINI_API_KEY="${GEMINI_API_KEY}" \
  --from-literal=DATABASE_URL="${DATABASE_URL}" \
  --from-literal=SUPABASE_URL="${SUPABASE_URL}" \
  --from-literal=SUPABASE_SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY}" \
  --from-literal=RABBITMQ_URL="${RABBITMQ_URL}" \
  --dry-run=client -o yaml | apply

echo "✅ Secrets applied in namespace ${NAMESPACE}:"
echo "   • ${BROKER_SECRET}      (Bitnami RabbitMQ chart: rabbitmq-password)"
echo "   • ${KEDA_SECRET}  (KEDA TriggerAuthentication + worker AMQP URL)"
echo "   • ${WORKER_SECRET}  (worker: Gemini, Postgres, Supabase)"
echo
echo "Next:"
echo "  kubectl get secret ${KEDA_SECRET} -n ${NAMESPACE}"
echo "  helm upgrade --install cv-tailoring charts/cv-tailoring-platform \\"
echo "    -f deploy/values/prod.yaml --set cv-tailoring-worker.existingSecret=${WORKER_SECRET} --atomic --wait"
