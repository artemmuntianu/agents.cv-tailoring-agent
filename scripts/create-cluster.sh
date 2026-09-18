#!/usr/bin/env bash
# Provision the AKS cluster (system pool + 0..N workload pool) and wire ACR.
#
#   RESOURCE_GROUP=rg-cvtailoring CLUSTER_NAME=cvtailoring ./scripts/create-cluster.sh
set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-rg-cvtailoring}"
CLUSTER_NAME="${CLUSTER_NAME:-cvtailoring}"
LOCATION="${LOCATION:-westeurope}"
USER_MAX_COUNT="${USER_MAX_COUNT:-5}"
BICEP_FILE="${BICEP_FILE:-deploy/infra/aks.bicep}"

az group create -n "${RESOURCE_GROUP}" -l "${LOCATION}" -o none

echo "🚀 Deploying ${BICEP_FILE} (system pool always-on, workload pool 0..${USER_MAX_COUNT})"
ACR_NAME=$(az deployment group create \
  -g "${RESOURCE_GROUP}" \
  -f "${BICEP_FILE}" \
  -p clusterName="${CLUSTER_NAME}" userMaxCount="${USER_MAX_COUNT}" \
  --query 'properties.outputs.acrLoginServer.value' -o tsv)

echo "📦 ACR: ${ACR_NAME}"
az aks get-credentials -g "${RESOURCE_GROUP}" -n "${CLUSTER_NAME}" --overwrite-existing -o none
az aks update -g "${RESOURCE_GROUP}" -n "${CLUSTER_NAME}" \
  --attach-acr "${ACR_NAME%%/*}" -o none

kubectl get nodes -L nodepool
echo "✅ Cluster ready. Next: make chart-deps && make dev-secret && make deploy"
